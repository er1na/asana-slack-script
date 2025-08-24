import 'dotenv/config';

type Task = {
  gid: string;
  name: string;
  due_on?: string;
  due_at?: string;
  start_on?: string;
  permalink_url?: string;
  projects?: { name: string }[];
  custom_fields?: Array<{
    name: string;
    enum_value?: { name: string } | null;
    display_value?: string | null;
  }>;
};

const ASANA_TOKEN = process.env.ASANA_TOKEN!;
const WORKSPACE = process.env.ASANA_WORKSPACE_GID!;
const PROJECTS = (process.env.ASANA_PROJECT_GIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const ASSIGNEE = process.env.ASANA_ASSIGNEE_GID || '';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const CHANNEL = process.env.SLACK_CHANNEL_ID || '';

if (!ASANA_TOKEN) {
  console.error('ASANA_TOKEN が未設定です');
  process.exit(1);
}
if (!WORKSPACE) {
  console.error('ASANA_WORKSPACE_GID が未設定です');
  process.exit(1);
}
if (!WEBHOOK && !(BOT_TOKEN && CHANNEL)) {
  console.error('Slack 送信先が未設定です（WEBHOOK か BOT_TOKEN+CHANNEL のどちらか）');
  process.exit(1);
}

function ymdJSTFromNow(offsetDays = 0): string {
  const nowUtc = Date.now();
  const jstMs = nowUtc + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

function jstDayToUtcRange(yyyyMmDd: string) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  // JST 00:00 は UTC -9:00
  const startUtc = new Date(Date.UTC(y, m - 1, d, -9, 0, 0));
  const endUtc = new Date(Date.UTC(y, m - 1, d + 1, -9, 0, 0));
  return { after: startUtc.toISOString(), before: endUtc.toISOString() };
}

function resolveTargetDateJST(): string {
  const argIndex = process.argv.indexOf('--date');
  const envOverride = process.env.DATE_OVERRIDE;

  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    const v = process.argv[argIndex + 1];
    if (v === 'today') return ymdJSTFromNow(0);
    if (v === 'tomorrow') return ymdJSTFromNow(1);
    return v;
  }
  if (envOverride) return envOverride;

  return ymdJSTFromNow(0);
}

async function asanaFetch(path: string, params: Record<string, string>) {
  const url = new URL(`https://app.asana.com/api/1.0${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Asana API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const COMMON_FIELDS =
  'name,assignee.name,projects.name,permalink_url,due_on,due_at,start_on,' +
  'custom_fields.name,custom_fields.enum_value.name,custom_fields.display_value';

async function searchTasksByDueOn(dateJst: string): Promise<Task[]> {
  const base: Record<string, string> = {
    completed: 'false',
    opt_fields: COMMON_FIELDS,
    limit: '100',
    ...(ASSIGNEE ? { 'assignee.any': ASSIGNEE } : {}),
    ...(PROJECTS.length ? { 'projects.any': PROJECTS.join(',') } : {}),
  };

  const results: Task[] = [];
  const seen = new Set<string>();

  async function page(path: string, params: Record<string, string>) {
    async function fetchPage(extra: Record<string, string> = {}) {
      const data = await asanaFetch(path, { ...params, ...extra });
      for (const t of data.data as Task[]) {
        if (!seen.has(t.gid)) {
          seen.add(t.gid);
          results.push(t);
        }
      }
      const next = (data as any)?.next_page?.offset;
      if (next) await fetchPage({ offset: next });
    }
    await fetchPage();
  }

  await page(`/workspaces/${WORKSPACE}/tasks/search`, { ...base, due_on: dateJst });

  const { after, before } = jstDayToUtcRange(dateJst);
  await page(`/workspaces/${WORKSPACE}/tasks/search`, {
    ...base,
    'due_at.after': after,
    'due_at.before': before,
  });

  return results;
}

async function searchTasksStartingOn(dateJst: string): Promise<Task[]> {
  const base: Record<string, string> = {
    completed: 'false',
    
    'start_on.before': dateJst,
    'start_on.after': dateJst,
    opt_fields: COMMON_FIELDS,
    limit: '100',
    ...(ASSIGNEE ? { 'assignee.any': ASSIGNEE } : {}),
    ...(PROJECTS.length ? { 'projects.any': PROJECTS.join(',') } : {}),
  };

  const results: Task[] = [];
  async function fetchPage(extra: Record<string, string> = {}) {
    const data = await asanaFetch(`/workspaces/${WORKSPACE}/tasks/search`, { ...base, ...extra });
    results.push(...(data.data as Task[]));
    const next = (data as any)?.next_page?.offset;
    if (next) await fetchPage({ offset: next });
  }

  await fetchPage();
  return results;
}

const TARGET_FIELD_NAMES = ['午前I', '午前II', '午後I', '午後II'];

function buildFieldLabels(t: Task): string {
  const cf = t.custom_fields ?? [];
  const parts = TARGET_FIELD_NAMES.map(n => {
    const f = cf.find(x => x.name === n);
    const val = f?.enum_value?.name ?? f?.display_value ?? '';
    return val ? `${n}:${val}` : '';
  }).filter(Boolean);
  return parts.length ? ` [${parts.join(' / ')}]` : '';
}

function formatDueMessage(date: string, tasks: Task[]) {
  if (tasks.length === 0) return `【${date} 期日のタスク】なし`;
  const lines = tasks.map(t => {
    const proj = t.projects?.[0]?.name ?? '（No Project）';
    const labels = buildFieldLabels(t);
    const link = t.permalink_url ? ` <${t.permalink_url}|open>` : '';
    return `・${proj} / ${t.name}${labels}${link}`;
  });
  return [`【${date} が期日のタスク】`, ...lines].join('\n');
}

function formatStartMessage(date: string, tasks: Task[]) {
  if (tasks.length === 0) return `【${date} に開始するタスク】なし`;
  const lines = tasks
    .sort((a, b) => (a.projects?.[0]?.name ?? '').localeCompare(b.projects?.[0]?.name ?? '', 'ja'))
    .map(t => {
      const proj = t.projects?.[0]?.name ?? '（No Project）';
      const labels = buildFieldLabels(t);
      const link = t.permalink_url ? ` <${t.permalink_url}|open>` : '';
      return `・${proj} / ${t.name}${labels}${link}`;
    });
  return [`【${date} に開始するタスク】`, ...lines].join('\n');
}

/** ----- Slack ----- **/

async function postToSlack(text: string) {
  if (WEBHOOK) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Asana',
        icon_emoji: ':ribbon:',
        text,
      }),
    });
    if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
    return;
  }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: CHANNEL, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${JSON.stringify(data)}`);
}

/** ----- main ----- **/

async function main() {
  const date = resolveTargetDateJST();
  console.log('[DEBUG] Using JST date:', date, 'runner utc now:', new Date().toISOString());

  const dueTasks = await searchTasksByDueOn(date);
  const startTasks = await searchTasksStartingOn(date);

  const dueMsg = formatDueMessage(date, dueTasks);
  const startMsg = formatStartMessage(date, startTasks);

  console.log('--- Start message ---\n' + startMsg + '\n---------------------');
  console.log('--- Due message   ---\n' + dueMsg + '\n---------------------');

  await postToSlack('────────────────');
  await postToSlack(startMsg);
  await postToSlack('\n');
  await postToSlack(dueMsg);
  await postToSlack('────────────────');

  console.log('Sent to Slack:', date, `due=${dueTasks.length}, start=${startTasks.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
