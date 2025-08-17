import 'dotenv/config';

type Task = {
  gid: string;
  name: string;
  due_on?: string;
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
const PROJECTS = (process.env.ASANA_PROJECT_GIDS || '').split(',').map(s => s.trim()).filter(Boolean);
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
  console.error('Slack 送信先が未設定です');
  process.exit(1);
}

async function asanaFetch(path: string, params: Record<string, string>) {
  const url = new URL(`https://app.asana.com/api/1.0${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Asana API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function resolveTargetDateJST(): string {
  const argIndex = process.argv.indexOf('--date');
  const envOverride = process.env.DATE_OVERRIDE;
  const jst = new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));

  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    const v = process.argv[argIndex + 1];
    if (v === 'today') return jst.toISOString().slice(0, 10);
    if (v === 'tomorrow') { jst.setDate(jst.getDate() + 1); return jst.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }); }
    return v;
  }
  if (envOverride) return envOverride;

  return jst.toISOString().slice(0, 10);
}

async function searchTasksByDueOn(due: string): Promise<Task[]> {
  const COMMON_FIELDS =
  'name,assignee.name,projects.name,permalink_url,due_on,start_on,' +
  'custom_fields.name,custom_fields.enum_value.name,custom_fields.display_value';
  const params: Record<string, string> = {
    workspace: WORKSPACE,
    'completed': 'false',
    'due_on': due,
    opt_fields: COMMON_FIELDS,
    'limit': '100'
  };
  if (ASSIGNEE) params['assignee.any'] = ASSIGNEE;

  const results: Task[] = [];

  async function fetchPage(extra: Record<string, string> = {}) {
    const data = await asanaFetch(`/workspaces/${WORKSPACE}/tasks/search`, { ...params, ...extra, ...(PROJECTS.length ? { 'projects.any': PROJECTS.join(',') } : {}) });
    results.push(...(data.data as Task[]));
    const next = data?.next_page?.offset;
    if (next) {
      await fetchPage({ offset: next });
    }
  }

  await fetchPage();
  return results;
}

async function searchTasksStartingOn(date: string): Promise<Task[]> {
  const COMMON_FIELDS =
  'name,assignee.name,projects.name,permalink_url,due_on,start_on,' +
  'custom_fields.name,custom_fields.enum_value.name,custom_fields.display_value';
  const base: Record<string, string> = {
    completed: 'false',
    'start_on.before': date,
    'start_on.after': date,
    opt_fields: COMMON_FIELDS,
    limit: '100',
  };
  if (ASSIGNEE) base['assignee.any'] = ASSIGNEE;
  if (PROJECTS.length) base['projects.any'] = PROJECTS.join(',');

  const results: Task[] = [];

  async function fetchPage(extra: Record<string, string> = {}) {
    const data = await asanaFetch(`/workspaces/${WORKSPACE}/tasks/search`, {
      ...base,
      ...extra,
    });
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
    const val =
      f?.enum_value?.name ??
      f?.display_value ?? '';
    return val ? `${n}:${val}` : '';
  }).filter(Boolean);
  return parts.length ? ` [${parts.join(' / ')}]` : '';
}

function formatSlackMessage(due: string, tasks: Task[]) {
  if (tasks.length === 0) return `【${due} 期日のタスク】なし`;
  const lines = tasks.map(t => {
    const projectName = t.projects?.[0]?.name ?? '（No Project）';
    const link = t.permalink_url ? ` <${t.permalink_url}|open>` : '';
    const labels = buildFieldLabels(t);
    return `・${projectName} / ${t.name}${labels}${link}`;
  });
  return [`【${due} が期日のタスク】`, ...lines].join('\n');
}

function formatStartMessage(date: string, tasks: Task[]) {
  if (tasks.length === 0) return `【${date} に開始するタスク】なし`;
  const lines = tasks
    .sort((a, b) => (a.projects?.[0]?.name ?? '').localeCompare(b.projects?.[0]?.name ?? '', 'ja'))
    .map(t => {
      const proj = t.projects?.[0]?.name ?? '（No Project）';
      const link = t.permalink_url ? ` <${t.permalink_url}|open>` : '';
      const labels = buildFieldLabels(t);
      return `・${proj} / ${t.name}${labels}${link}`;
    });
  return [`【${date} に開始するタスク】`, ...lines].join('\n');
}


async function postToSlack(text: string) {
  if (process.env.SLACK_WEBHOOK_URL) {
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Asana',
        icon_emoji: ':ribbon:',
        text 
      })
    });
    if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
    return;
  }
 
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${BOT_TOKEN}`
    },
    body: JSON.stringify({ channel: CHANNEL, text })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${JSON.stringify(data)}`);
}

async function main() {
  const due = resolveTargetDateJST();
  const tasks = await searchTasksByDueOn(due);
  const msg = formatSlackMessage(due, tasks);
  const startTasks = await searchTasksStartingOn(due);
  const startMsg = formatStartMessage(due, startTasks);
  console.log('--- Due message ---\n' + msg + '\n---------------------');
  console.log('--- Start message ---\n' + startMsg + '\n---------------------');
  await postToSlack('\n');
  await postToSlack('────────────────');
  await postToSlack(startMsg);
  await postToSlack('\n');
  await postToSlack(msg);
  await postToSlack('────────────────');
  console.log('Sent to Slack:', due, `${tasks.length} tasks`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
