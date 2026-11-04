import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3,
  ExternalLink, ListPlus, LoaderCircle, LockKeyhole, Plus, RefreshCw,
  Monitor, Moon, Settings2, ShieldCheck, Sun, Trash2, X,
} from 'lucide-react';

const STORE_KEY = 'jiraBulkLoggerState';
const COMPLETION_KEY = 'jiraTimekeeperCompletedDay';
const DEFAULT_CAP = 8;
const DEFAULT_REMINDER_SETTINGS = { enabled: false, dailyTime: '16:00', snoozeMinutes: 15 };
const DESCRIPTION_FONT_SIZE_VERSION = 2;
const DEFAULT_STATE = { credentials: null, cap: DEFAULT_CAP, drafts: {}, myOwnIssueKeys: [], showRecentTickets: true, theme: 'system', descriptionFontSize: 12, descriptionFontSizeVersion: DESCRIPTION_FONT_SIZE_VERSION, reminderSettings: DEFAULT_REMINDER_SETTINGS, day: todayKey() };

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatDate() {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
}

function readStorage(key) {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) chrome.storage.local.get(key, (data) => resolve(data[key]));
    else resolve(JSON.parse(localStorage.getItem(key) || 'null'));
  });
}

function writeStorage(key, value) {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) chrome.storage.local.set({ [key]: value }, resolve);
    else { localStorage.setItem(key, JSON.stringify(value)); resolve(); }
  });
}

function parseSiteUrl(value) {
  const input = value.trim();
  if (!input) throw new Error('Enter your Jira site URL.');
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:') throw new Error('Jira site URLs must use HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter only your Jira site address, without credentials or query parameters.');
  return url.origin;
}

function base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function jiraRequest(credentials, endpoint, options = {}) {
  let response;
  try {
    response = await fetch(`${credentials.site}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${base64(`${credentials.email}:${credentials.token}`)}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error('Could not reach Jira. Check the site URL, your internet connection, and Chrome’s Jira site access.');
  }
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.errorMessages?.[0] || body?.message;
    if (response.status === 401) throw new Error('Jira did not accept these credentials. Check your email and API token.');
    if (response.status === 403) throw new Error('Jira denied access. Check your issue permissions and time-tracking access.');
    throw new Error(detail || `Jira returned an error (${response.status}).`);
  }
  return body;
}

function mapJiraIssue(issue, credentials) {
  return {
    key: issue.key,
    title: issue.fields?.summary || 'Untitled issue',
    project: issue.fields?.project?.name || issue.key.split('-')[0],
    type: issue.fields?.issuetype?.name || 'Issue',
    estimateMinutes: Number.isFinite(issue.fields?.timetracking?.originalEstimateSeconds)
      ? Math.ceil(issue.fields.timetracking.originalEstimateSeconds / 60)
      : null,
    url: `${credentials.site}/browse/${issue.key}`,
  };
}

async function searchIssues(credentials, jql) {
  const data = await jiraRequest(credentials, '/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: ['summary', 'issuetype', 'project', 'timetracking'], maxResults: 50 }),
  });
  return (data?.issues || []).map((issue) => mapJiraIssue(issue, credentials));
}

async function searchWorklogIssues(credentials, jql) {
  const issues = [];
  let nextPageToken;
  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
    const data = await jiraRequest(credentials, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        fields: ['summary', 'issuetype', 'project', 'timetracking'],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    issues.push(...(data?.issues || []).map((issue) => mapJiraIssue(issue, credentials)));
    nextPageToken = data?.nextPageToken;
    if (!nextPageToken) break;
  }
  return issues;
}

function escapeJqlString(value) {
  return `"${String(value).replace(/[\r\n]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function searchClause(query) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return '';
  const key = trimmedQuery.toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(key)
    ? ` AND key = ${key}`
    : ` AND summary ~ ${escapeJqlString(trimmedQuery)}`;
}

async function getRecentIssues(credentials, query = '') {
  // Recent tickets are assigned to the connected user and updated today.
  // This single JQL search avoids per-ticket changelog calls.
  const jql = `assignee = currentUser() AND updated >= startOfDay()${searchClause(query)} ORDER BY updated DESC`;
  return searchIssues(credentials, jql);
}

async function searchMyOwnIssues(credentials, query) {
  return searchIssues(credentials, `assignee = currentUser()${searchClause(query)} ORDER BY updated DESC`);
}

async function mapWithConcurrency(items, limit, callback) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await callback(items[index]);
    }
  });
  await Promise.all(workers);
}

function dateKeyInTimeZone(date, timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function zonedMidnight(day, timeZone) {
  const [year, month, date] = day.split('-').map(Number);
  const target = Date.UTC(year, month - 1, date);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
    if (timeZone) options.timeZone = timeZone;
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    timestamp += target - represented;
  }
  return timestamp;
}

async function getTodaysWorklogs(credentials) {
  const profile = await jiraRequest(credentials, '/rest/api/3/myself');
  if (!profile?.accountId) throw new Error('Could not identify the Jira account to read today’s worklogs.');
  const timeZone = profile.timeZone || '';
  const today = dateKeyInTimeZone(new Date(), timeZone);
  const candidates = await searchWorklogIssues(
    credentials,
    'worklogAuthor = currentUser() AND worklogDate >= startOfDay() AND worklogDate <= endOfDay()',
  );
  const start = zonedMidnight(today, timeZone);
  const end = zonedMidnight(today, timeZone) + 36 * 60 * 60 * 1000;
  const perIssueSeconds = {};
  const perIssueWorklogs = {};
  let failedIssues = 0;
  await mapWithConcurrency(candidates, 5, async (issue) => {
    try {
    let startAt = 0;
    let total = 0;
    let pageCount = 0;
    do {
      const page = await jiraRequest(
        credentials,
        `/rest/api/3/issue/${encodeURIComponent(issue.key)}/worklog?startedAfter=${start}&startedBefore=${end}&startAt=${startAt}&maxResults=1000`,
      );
      const worklogs = page?.worklogs || [];
      for (const worklog of worklogs) {
        if (worklog.author?.accountId === profile.accountId && dateKeyInTimeZone(new Date(worklog.started), timeZone) === today) {
          const seconds = Number(worklog.timeSpentSeconds) || 0;
          total += seconds;
          (perIssueWorklogs[issue.key] ||= []).push({
            id: String(worklog.id),
            started: worklog.started,
            seconds,
            minutes: Math.round(seconds / 60),
            description: worklogCommentText(worklog.comment),
          });
        }
      }
      startAt += worklogs.length;
      pageCount += 1;
      if (!worklogs.length || startAt >= (Number(page?.total) || 0) || pageCount >= 20) break;
    } while (true);
    if (total) perIssueSeconds[issue.key] = total;
    } catch {
      failedIssues += 1;
    }
  });

  const byIssue = Object.fromEntries(Object.entries(perIssueSeconds).map(([key, seconds]) => [key, Math.round(seconds / 60)]));
  const totalMinutes = Math.round(Object.values(perIssueSeconds).reduce((sum, seconds) => sum + seconds, 0) / 60);
  return { day: today, totalMinutes, byIssue, worklogsByIssue: perIssueWorklogs, failedIssues };
}

function worklogCommentText(comment) {
  if (typeof comment === 'string') return comment;
  const textFrom = (node) => {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    const children = (node.content || []).map(textFrom).join('');
    return node.type === 'paragraph' || node.type === 'heading' ? `${children}\n` : children;
  };
  return textFrom(comment).trim();
}

async function getIssueDetails(credentials, keys) {
  const results = await Promise.all(keys.map(async (key) => {
    try {
      const data = await jiraRequest(credentials, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,project,timetracking`);
      return mapJiraIssue(data, credentials);
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

function includeIssuesAsDrafts(drafts, issues) {
  const nextDrafts = { ...drafts };
  issues.forEach((issue) => {
    const existing = nextDrafts[issue.key];
    nextDrafts[issue.key] = existing
      ? { ...existing, issue }
      : { issue, entries: [{ id: crypto.randomUUID(), hours: '' }], description: '', submittedAt: null };
  });
  return nextDrafts;
}

function convertLegacyTimeDrafts(drafts, loggedByIssue = {}) {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => {
    if (draft.remainingHours !== undefined) {
      return [key, { ...draft, ticketHours: undefined, autoHours: undefined }];
    }
    const legacyTotal = draft.ticketHours ?? draft.autoHours;
    if (legacyTotal === undefined) return [key, draft];
    const remaining = Math.max(0, parseMinutes(legacyTotal) - (loggedByIssue[key] || 0));
    return [key, {
      ...draft,
      remainingHours: formatHours(remaining),
      ticketHours: undefined,
      autoHours: undefined,
    }];
  }));
}

function parseMinutes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 60);
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!minutes) return '0h';
  if (!remainder) return `${hours}h`;
  if (!hours) return `${remainder}m`;
  return `${hours}h ${remainder}m`;
}

function formatHours(minutes) {
  return (minutes / 60).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function getWorklogStarted() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (number) => String(Math.floor(Math.abs(number))).padStart(2, '0');
  const zone = `${sign}${pad(offset / 60)}${pad(offset % 60)}`;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.000${zone}`;
}

function toWorklogComment(description) {
  const paragraphs = description.trim().split(/\n+/).map((text) => text.trim()).filter(Boolean);
  if (!paragraphs.length) return undefined;
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

function App() {
  const [appState, setAppState] = useState(DEFAULT_STATE);
  const [completionDay, setCompletionDay] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [issues, setIssues] = useState([]);
  const [todayWorklogs, setTodayWorklogs] = useState({ day: todayKey(), totalMinutes: 0, byIssue: {}, worklogsByIssue: {} });
  const [worklogsLoaded, setWorklogsLoaded] = useState(false);
  const [worklogError, setWorklogError] = useState('');
  const [screen, setScreen] = useState('home');
  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [form, setForm] = useState({ site: '', email: '', token: '' });
  const [showToken, setShowToken] = useState(false);
  const [reminderSource, setReminderSource] = useState(() => new URLSearchParams(window.location.search).get('reminder') || '');
  const [snoozeFeedback, setSnoozeFeedback] = useState('');
  const [currentTabId, setCurrentTabId] = useState(null);
  const fullPage = new URLSearchParams(window.location.search).get('full') === '1';

  useEffect(() => {
    setConnectionError('');
  }, [form.site, form.email, form.token]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const theme = appState.theme || 'system';
      document.documentElement.dataset.theme = theme === 'system'
        ? (media.matches ? 'dark' : 'light')
        : theme;
    };
    applyTheme();
    if (appState.theme !== 'system') return undefined;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [appState.theme]);

  useEffect(() => {
    Promise.all([readStorage(STORE_KEY), readStorage(COMPLETION_KEY)]).then(([saved, savedCompletionDay]) => {
      const next = {
        ...DEFAULT_STATE,
        ...(saved || {}),
        reminderSettings: { ...DEFAULT_REMINDER_SETTINGS, ...(saved?.reminderSettings || {}) },
      };
      if (saved?.descriptionFontSizeVersion !== DESCRIPTION_FONT_SIZE_VERSION) {
        next.descriptionFontSize = 12;
        next.descriptionFontSizeVersion = DESCRIPTION_FONT_SIZE_VERSION;
      }
      if (next.day !== todayKey()) {
        const retainedOwnKeys = (next.myOwnIssueKeys || [])
          .filter((key) => next.drafts?.[key]?.issue);
        next.myOwnIssueKeys = retainedOwnKeys;
        next.drafts = Object.fromEntries(retainedOwnKeys.map((key) => [key, {
          ...next.drafts[key],
          entries: [{ id: crypto.randomUUID(), hours: '' }],
          description: '',
          autoHours: undefined,
          remainingHours: undefined,
          ticketHours: undefined,
          worklogEdits: {},
          submittedAt: null,
          submitError: '',
        }]));
        next.day = todayKey();
      } else {
        next.myOwnIssueKeys = next.myOwnIssueKeys || [];
        next.drafts = Object.fromEntries(Object.entries(next.drafts || {}).map(([key, draft]) => [
          key,
          {
            ...(draft.submittedAt
              ? { ...draft, entries: [{ id: crypto.randomUUID(), hours: '' }], description: '', submittedAt: null }
              : draft),
            ...(next.myOwnIssueKeys.includes(key) ? { source: 'own' } : {}),
          },
        ]));
      }
      setAppState(next);
      setCompletionDay(savedCompletionDay || null);
      setForm({ site: next.credentials?.site || '', email: next.credentials?.email || '', token: next.credentials?.token || '' });
      setHydrated(true);
      if (next.credentials) setScreen('home');
      else setScreen('setup');
      if (next.credentials) loadIssues(next.credentials, next.drafts);
    });
  }, []);

  useEffect(() => {
    if (!globalThis.chrome?.runtime?.onMessage) return undefined;
    const onMessage = (message) => {
      if (message?.type === 'JIRA_REMINDER_TRIGGERED' && fullPage && message.tabId === currentTabId) {
        setReminderSource(message.source || 'daily');
        setSnoozeFeedback('');
      }
      if (message?.type === 'JIRA_LOGS_COMPLETED') {
        setCompletionDay(message.day || todayKey());
        setReminderSource('');
        setSnoozeFeedback('');
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [currentTabId, fullPage]);

  useEffect(() => {
    if (!fullPage || !globalThis.chrome?.tabs?.getCurrent || !globalThis.chrome?.runtime?.sendMessage) return;
    chrome.tabs.getCurrent((tab) => {
      if (typeof tab?.id !== 'number') return;
      setCurrentTabId(tab.id);
      chrome.runtime.sendMessage({ type: 'JIRA_REGISTER_REMINDER_TAB', tabId: tab.id }, () => { void chrome.runtime.lastError; });
    });
  }, [fullPage]);

  useEffect(() => {
    if (!globalThis.chrome?.storage?.onChanged) return undefined;
    const onStorageChanged = (changes, areaName) => {
      if (areaName === 'local' && changes[COMPLETION_KEY]) {
        setCompletionDay(changes[COMPLETION_KEY].newValue || null);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  useEffect(() => {
    if (hydrated) writeStorage(STORE_KEY, appState);
  }, [appState, hydrated]);

  const minutesPerIssue = useMemo(() => Object.fromEntries(
    Object.entries(appState.drafts).map(([key, draft]) => [
      key,
      draft.entries.reduce((sum, entry) => sum + parseMinutes(entry.hours), 0),
    ]),
  ), [appState.drafts]);
  const capMinutes = Math.round((Number(appState.cap) || DEFAULT_CAP) * 60);
  const activeIssues = useMemo(() => {
    // Saved drafts are the source of truth for selected tickets. Keep their
    // issue records available even if a refresh no longer returns the issue.
    const available = new Map(issues.map((issue) => [issue.key, issue]));
    Object.values(appState.drafts).forEach((draft) => {
      if (draft.issue && !available.has(draft.issue.key)) available.set(draft.issue.key, draft.issue);
    });
    const selected = [...available.values()].filter((issue) => appState.drafts[issue.key]);
    const ownOrder = new Map((appState.myOwnIssueKeys || []).map((key, index) => [key, index]));
    let nextOwnIndex = ownOrder.size;
    selected.forEach((issue) => {
      if (appState.drafts[issue.key]?.source === 'own' && !ownOrder.has(issue.key)) {
        ownOrder.set(issue.key, nextOwnIndex++);
      }
    });
    const ordered = selected
      .map((issue, index) => ({ issue, index, ownIndex: ownOrder.get(issue.key) }))
      .sort((a, b) => {
        if (a.ownIndex != null && b.ownIndex != null) return a.ownIndex - b.ownIndex;
        if (a.ownIndex != null) return -1;
        if (b.ownIndex != null) return 1;
        return a.index - b.index;
      })
      .map(({ issue }) => issue);
    return appState.showRecentTickets === false
      ? ordered.filter((issue) => ownOrder.has(issue.key))
      : ordered;
  }, [issues, appState.drafts, appState.myOwnIssueKeys, appState.showRecentTickets]);
  const autoIssueKey = activeIssues.at(-1)?.key || null;
  const baseRemaining = Object.fromEntries(activeIssues.map((issue) => {
    const draft = appState.drafts[issue.key];
    const logged = todayWorklogs.byIssue[issue.key] || 0;
    if (draft.remainingHours !== undefined) return [issue.key, parseMinutes(draft.remainingHours)];
    if (draft.ticketHours !== undefined || draft.autoHours !== undefined) {
      return [issue.key, Math.max(0, parseMinutes(draft.ticketHours ?? draft.autoHours) - logged)];
    }
    return [issue.key, logged > 0 ? 0 : minutesPerIssue[issue.key] || 0];
  }));
  const manualMinutesBeforeAuto = activeIssues.reduce((sum, issue) => (
    issue.key === autoIssueKey ? sum : sum + (baseRemaining[issue.key] || 0)
  ), 0);
  const autoMinutes = autoIssueKey
    ? Math.max(0, capMinutes - todayWorklogs.totalMinutes - manualMinutesBeforeAuto)
    : 0;
  const autoDraft = autoIssueKey ? appState.drafts[autoIssueKey] : undefined;
  const autoRemaining = autoDraft?.remainingHours !== undefined
    ? parseMinutes(autoDraft.remainingHours)
    : autoDraft?.ticketHours !== undefined || autoDraft?.autoHours !== undefined
      ? Math.max(0, parseMinutes(autoDraft.ticketHours ?? autoDraft.autoHours) - (todayWorklogs.byIssue[autoIssueKey] || 0))
      : autoMinutes;
  const remainingMinutesPerIssue = {
    ...baseRemaining,
    ...(autoIssueKey ? { [autoIssueKey]: autoRemaining } : {}),
  };
  const pendingMinutes = activeIssues.reduce((sum, issue) => sum + (remainingMinutesPerIssue[issue.key] || 0), 0);
  const totalMinutes = todayWorklogs.totalMinutes + pendingMinutes;
  const remainingLoggedMinutes = Math.max(0, capMinutes - todayWorklogs.totalMinutes);
  const overCap = totalMinutes > capMinutes;
  const connected = Boolean(appState.credentials);
  const pendingCount = activeIssues.filter((issue) => (remainingMinutesPerIssue[issue.key] || 0) > 0).length;
  const hiddenRecentCount = Object.keys(appState.drafts).filter((key) => !(appState.myOwnIssueKeys || []).includes(key)).length;
  const logsComplete = worklogsLoaded && todayWorklogs.totalMinutes >= capMinutes;
  const wellDone = logsComplete || completionDay === todayKey();

  useEffect(() => {
    if (!hydrated || !worklogsLoaded || todayWorklogs.totalMinutes < capMinutes) return;
    const day = todayKey();
    setCompletionDay(day);
    writeStorage(COMPLETION_KEY, day);
  }, [hydrated, worklogsLoaded, todayWorklogs.totalMinutes, capMinutes]);

  async function authorizeSite(site) {
    if (!globalThis.chrome?.permissions?.request) return true;
    const permission = await chrome.permissions.request({ origins: [`${site}/*`] });
    if (!permission) throw new Error('Chrome site access was not granted. Allow access to your Jira site to continue.');
    return true;
  }

  async function loadIssues(credentials = appState.credentials, retainedDrafts = appState.drafts) {
    if (!credentials) return;
    setBusy(true);
    setPageError('');
    setWorklogError('');
    try {
      const [listResult, worklogsResult] = await Promise.allSettled([
        getRecentIssues(credentials),
        getTodaysWorklogs(credentials),
      ]);
      if (listResult.status === 'rejected') throw listResult.reason;
      const list = listResult.value;
      const recentKeys = new Set(list.map((issue) => issue.key));
      const retained = Object.values(retainedDrafts)
        .map((draft) => draft.issue)
        .filter((issue) => issue && !recentKeys.has(issue.key));
      setIssues([...list, ...retained]);
      if (worklogsResult.status === 'fulfilled') {
        setTodayWorklogs(worklogsResult.value);
        setWorklogsLoaded(true);
        setWorklogError(worklogsResult.value.failedIssues
          ? `Could not read today’s worklogs for ${worklogsResult.value.failedIssues} ticket${worklogsResult.value.failedIssues === 1 ? '' : 's'}.`
          : '');
        if (worklogsResult.value.totalMinutes >= Math.round((Number(appState.cap) || DEFAULT_CAP) * 60)) {
          setCompletionDay(todayKey());
          writeStorage(COMPLETION_KEY, todayKey());
        }
        // Include tickets with existing worklogs, even if they were not updated today.
        const loggedTickets = Object.keys(worklogsResult.value.byIssue);
        if (loggedTickets.length) {
          const loggedIssues = await getIssueDetails(credentials, loggedTickets);
          const merged = new Map([...list, ...retained].map((issue) => [issue.key, issue]));
          loggedIssues.forEach((issue) => merged.set(issue.key, issue));
          setIssues([...merged.values()]);
          setAppState((current) => ({ ...current, drafts: includeIssuesAsDrafts(current.drafts, loggedIssues) }));
        }
        setAppState((current) => ({
          ...current,
          drafts: includeIssuesAsDrafts(
            convertLegacyTimeDrafts(current.drafts, worklogsResult.value.byIssue),
            list,
          ),
        }));
      } else {
        setWorklogsLoaded(false);
        setWorklogError(worklogsResult.reason?.message || 'Could not fetch today’s Jira worklogs.');
      }
      if (worklogsResult.status !== 'fulfilled') {
        setAppState((current) => ({ ...current, drafts: includeIssuesAsDrafts(current.drafts, list) }));
      }
    } catch (error) {
      setPageError(error.message || 'Could not load Jira issues.');
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection(event) {
    event.preventDefault();
    setConnectionError('');
    setBusy(true);
    try {
      const credentials = {
        site: parseSiteUrl(form.site),
        email: form.email.trim(),
        token: form.token.trim(),
      };
      if (!credentials.email || !credentials.token) throw new Error('Enter the Atlassian email and API token for your account.');
      await authorizeSite(credentials.site);
      const [recentResult, worklogsResult] = await Promise.allSettled([
        getRecentIssues(credentials),
        getTodaysWorklogs(credentials),
      ]);
      if (recentResult.status === 'rejected') throw recentResult.reason;
      const recentIssues = recentResult.value;
      const worklogs = worklogsResult.status === 'fulfilled' ? worklogsResult.value : null;
      const loggedIssues = worklogs ? await getIssueDetails(credentials, Object.keys(worklogs.byIssue)) : [];
      const retainedIssues = Object.values(appState.drafts).map((draft) => draft.issue).filter(Boolean);
      const visibleIssues = [...new Map([...recentIssues, ...loggedIssues, ...retainedIssues].map((issue) => [issue.key, issue])).values()];
      const nextState = {
        ...appState,
        credentials,
        drafts: includeIssuesAsDrafts(convertLegacyTimeDrafts(appState.drafts, worklogs?.byIssue || {}), visibleIssues),
      };
      await writeStorage(STORE_KEY, nextState);
      setAppState(nextState);
      setIssues(visibleIssues);
      if (worklogs) {
        setTodayWorklogs(worklogs);
        setWorklogsLoaded(true);
        setWorklogError(worklogs.failedIssues
          ? `Could not read today’s worklogs for ${worklogs.failedIssues} ticket${worklogs.failedIssues === 1 ? '' : 's'}.`
          : '');
      } else {
        setWorklogsLoaded(false);
        setWorklogError(worklogsResult.reason?.message || 'Could not fetch today’s Jira worklogs.');
      }
      setScreen('home');
    } catch (error) {
      setConnectionError(error.message || 'Could not connect to Jira.');
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(issueKey, transform) {
    setAppState((current) => {
      const draft = current.drafts[issueKey];
      if (!draft) return current;
      return { ...current, drafts: { ...current.drafts, [issueKey]: transform(draft) } };
    });
  }

  function addEntry(issueKey) {
    updateDraft(issueKey, (draft) => ({ ...draft, entries: [...draft.entries, { id: crypto.randomUUID(), hours: '' }] }));
  }

  function updateEntry(issueKey, entryId, value) {
    if (!/^\d*\.?\d*$/.test(value)) return;
    updateDraft(issueKey, (draft) => ({
      ...draft,
      entries: draft.entries.map((entry) => entry.id === entryId ? { ...entry, hours: value } : entry),
    }));
  }

  function updateDescription(issueKey, value) {
    updateDraft(issueKey, (draft) => ({ ...draft, description: value }));
  }

  function updateTicketHours(issueKey, value) {
    if (!/^\d*\.?\d*$/.test(value)) return;
    updateDraft(issueKey, (draft) => ({ ...draft, remainingHours: value }));
  }

  function removeEntry(issueKey, entryId) {
    updateDraft(issueKey, (draft) => {
      const entries = draft.entries.filter((entry) => entry.id !== entryId);
      return { ...draft, entries: entries.length ? entries : [{ id: crypto.randomUUID(), hours: '' }] };
    });
  }

  function moveExcess(sourceKey, targetKey, excessMinutes) {
    setAppState((current) => {
      const source = current.drafts[sourceKey];
      const target = current.drafts[targetKey];
      if (!source || !target || sourceKey === targetKey) return current;
      const movedMinutes = Math.min(excessMinutes, remainingMinutesPerIssue[sourceKey] || 0);
      if (!movedMinutes) return current;
      return {
        ...current,
        drafts: {
          ...current.drafts,
          [sourceKey]: { ...source, remainingHours: formatHours((remainingMinutesPerIssue[sourceKey] || 0) - movedMinutes) },
          [targetKey]: { ...target, remainingHours: formatHours((remainingMinutesPerIssue[targetKey] || 0) + movedMinutes) },
        },
      };
    });
  }

  function selectIssue(issue, source = 'recent') {
    setIssues((current) => current.some((item) => item.key === issue.key)
      ? current.map((item) => item.key === issue.key ? issue : item)
      : [...current, issue]);
    setAppState((current) => ({
      ...current,
      drafts: {
        ...current.drafts,
        [issue.key]: {
          ...(current.drafts[issue.key] || { issue, entries: [{ id: crypto.randomUUID(), hours: '' }], description: '', submittedAt: null }),
          ...(source === 'own' ? { source: 'own' } : {}),
        },
      },
      myOwnIssueKeys: source === 'own'
        ? [...(current.myOwnIssueKeys || []).filter((key) => key !== issue.key), issue.key]
        : current.myOwnIssueKeys || [],
    }));
  }

  function prioritizeOwnIssue(issue) {
    setIssues((current) => current.some((item) => item.key === issue.key)
      ? current.map((item) => item.key === issue.key ? issue : item)
      : [...current, issue]);
    setAppState((current) => ({
      ...current,
      myOwnIssueKeys: [...(current.myOwnIssueKeys || []).filter((key) => key !== issue.key), issue.key],
      drafts: {
        ...current.drafts,
        [issue.key]: {
          ...(current.drafts[issue.key] || { issue, entries: [{ id: crypto.randomUUID(), hours: '' }], description: '', submittedAt: null }),
          source: 'own',
        },
      },
    }));
  }

  function removeIssue(issueKey) {
    setAppState((current) => {
      const drafts = { ...current.drafts };
      delete drafts[issueKey];
      return {
        ...current,
        drafts,
        myOwnIssueKeys: (current.myOwnIssueKeys || []).filter((key) => key !== issueKey),
      };
    });
  }

  function toggleIssue(issue, source) {
    const isSelected = Boolean(appState.drafts[issue.key]);
    const isPriority = (appState.myOwnIssueKeys || []).includes(issue.key);
    if (source === 'own') {
      if (!isSelected) selectIssue(issue, 'own');
      else if (!isPriority) prioritizeOwnIssue(issue);
      else removeIssue(issue.key);
      return;
    }
    if (isSelected) removeIssue(issue.key);
    else selectIssue(issue, 'recent');
  }

  async function submitLogs() {
    if (!appState.credentials || pendingCount === 0 || pendingMinutes === 0 || overCap) return;
    setBusy(true);
    setPageError('');
    let didWrite = false;
    for (const issue of activeIssues) {
      const draft = appState.drafts[issue.key];
      const minutes = remainingMinutesPerIssue[issue.key] || 0;
      if (minutes <= 0) continue;
      const existingWorklogs = todayWorklogs.worklogsByIssue?.[issue.key] || [];
      try {
        const describedRecord = [...existingWorklogs].reverse().find((record) => record.description) || existingWorklogs.at(-1);
        const description = draft.worklogDescription !== undefined
          ? draft.worklogDescription
          : describedRecord?.description || draft.description || '';
        const comment = toWorklogComment(description);
        await jiraRequest(appState.credentials, `/rest/api/3/issue/${encodeURIComponent(issue.key)}/worklog`, {
          method: 'POST',
          body: JSON.stringify({
            timeSpentSeconds: minutes * 60,
            started: getWorklogStarted(),
            ...(comment ? { comment } : {}),
          }),
        });
        didWrite = true;
        setAppState((current) => ({
          ...current,
          drafts: {
            ...current.drafts,
            [issue.key]: {
              ...current.drafts[issue.key],
              entries: [{ id: crypto.randomUUID(), hours: '' }],
              description: '',
              remainingHours: undefined,
              ticketHours: undefined,
              autoHours: undefined,
              worklogDescription: undefined,
              worklogEdits: {},
              submittedAt: null,
              submitError: '',
            },
          },
        }));
      } catch (error) {
        setAppState((current) => ({
          ...current,
          drafts: {
            ...current.drafts,
            [issue.key]: { ...current.drafts[issue.key], submitError: error.message || 'Could not submit this worklog.' },
          },
        }));
      }
    }
    setBusy(false);
    if (didWrite) {
      try {
        setTodayWorklogs(await getTodaysWorklogs(appState.credentials));
      } catch (error) {
        setWorklogError(error.message || 'Could not refresh today’s Jira worklogs.');
      }
    }
  }

  async function disconnect() {
    setAppState((current) => ({ ...current, credentials: null, drafts: {}, myOwnIssueKeys: [] }));
    setIssues([]);
    setForm({ site: '', email: '', token: '' });
    setConnectionError('');
    setPageError('');
    setScreen('setup');
  }

  function saveCap(value) {
    if (!value || Number(value) < 0.25 || Number(value) > 24) return;
    setAppState((current) => ({ ...current, cap: Number(value) }));
  }

  function openIssuePicker() {
    setShowIssuePicker(true);
  }

  function saveReminderSettings(reminderSettings) {
    setAppState((current) => ({
      ...current,
      reminderSettings: { ...DEFAULT_REMINDER_SETTINGS, ...current.reminderSettings, ...reminderSettings },
    }));
  }

  function snoozeReminder() {
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    setPageError('');
    chrome.runtime.sendMessage({ type: 'JIRA_SNOOZE_REMINDER' }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || !response?.ok) {
        setPageError(response?.message || runtimeError?.message || 'Could not snooze this reminder. Check that auto-open is enabled in Settings.');
        return;
      }
      setReminderSource('');
      const url = new URL(window.location.href);
      url.searchParams.delete('reminder');
      window.history.replaceState({}, '', url);
      if (fullPage && globalThis.chrome?.tabs?.getCurrent) {
        chrome.tabs.getCurrent((tab) => {
          if (typeof tab?.id === 'number') chrome.tabs.remove(tab.id, () => { void chrome.runtime.lastError; });
        });
      } else {
        setSnoozeFeedback(`Snoozed. Timekeeper will open again in ${response.snoozeMinutes} minutes.`);
      }
    });
  }

  if (!hydrated) return <div className="grid h-dvh min-h-[320px] place-items-center"><LoaderCircle size={22} className="animate-spin text-violet-600" /></div>;

  return (
    <main className={`flex h-dvh min-h-[320px] w-full min-w-[300px] flex-col overflow-hidden bg-[#f7f8fa] text-[#202531] ${fullPage ? 'mx-auto max-w-[840px] border-x border-slate-200 shadow-xl' : ''}`}>
      {screen === 'setup' ? (
        <SetupScreen
          form={form}
          setForm={setForm}
          theme={appState.theme || 'system'}
          onThemeChange={(theme) => setAppState((current) => ({ ...current, theme }))}
          showToken={showToken}
          setShowToken={setShowToken}
          error={connectionError}
          busy={busy}
          onSubmit={saveConnection}
          existing={connected}
          onBack={() => setScreen('home')}
        />
      ) : screen === 'settings' ? (
        <SettingsPage
          cap={appState.cap}
          reminderSettings={appState.reminderSettings}
          form={form}
          setForm={setForm}
          showToken={showToken}
          setShowToken={setShowToken}
          connectionError={connectionError}
          busy={busy}
          onSaveCap={saveCap}
          onSaveReminderSettings={saveReminderSettings}
          onSaveConnection={saveConnection}
          onBack={() => setScreen('home')}
          onDisconnect={disconnect}
        />
      ) : (
        <>
          <Header
            theme={appState.theme || 'system'}
            onThemeChange={(theme) => setAppState((current) => ({ ...current, theme }))}
            onSettings={() => setScreen('settings')}
          />
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 scrollbar-soft">
              {wellDone ? <WellDoneBanner /> : reminderSource ? <ReminderBanner source={reminderSource} snoozeMinutes={appState.reminderSettings.snoozeMinutes} onSnooze={snoozeReminder} /> : snoozeFeedback ? <SnoozedBanner message={snoozeFeedback} /> : null}
              <div className="mb-4 flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Your workday</p>
                  <h1 className="mt-1 text-[20px] font-semibold tracking-[-0.04em] text-slate-900">{formatDate()}</h1>
                </div>
                <button
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:border-violet-200 hover:text-violet-700 disabled:opacity-60"
                  onClick={() => loadIssues()}
                  disabled={busy}
                  title="Refresh recently viewed Jira issues"
                >
                  <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>

              <DailyProgress total={todayWorklogs.totalMinutes} cap={capMinutes} remaining={remainingLoggedMinutes} capValue={appState.cap} onChange={saveCap} />
              {worklogError && <div className="mt-2"><InlineAlert message={`${worklogError} Existing hours may be missing from the total until refreshed.`} /></div>}

              <div className="sticky top-0 z-10 -mx-4 mb-3 mt-5 flex items-center justify-between gap-2 border-b border-slate-200/80 bg-white px-4 py-2">
                <div>
                  <h2 className="text-[13px] font-semibold text-slate-800">Tickets to log</h2>
                  <p className="mt-0.5 text-[11px] text-slate-400">{activeIssues.length} tickets selected for today</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={appState.showRecentTickets !== false}
                    onClick={() => setAppState((current) => ({ ...current, showRecentTickets: current.showRecentTickets === false }))}
                    className={`flex items-center gap-1 rounded-lg border px-2 py-2 text-[11px] font-semibold transition ${appState.showRecentTickets !== false ? 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300' : 'border-slate-200 bg-white text-slate-500 hover:border-violet-200 hover:text-violet-700'}`}
                    title="Show or hide selected recent tickets"
                  >
                    Recent {appState.showRecentTickets !== false ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={openIssuePicker}
                    disabled={busy}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-semibold text-slate-600 transition hover:border-violet-200 hover:text-violet-700 disabled:opacity-50"
                  >
                    <ListPlus size={14} /> Manage
                  </button>
                </div>
              </div>

              {pageError && <InlineAlert message={pageError} />}

              {busy && issues.length === 0 && activeIssues.length === 0 ? (
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-4 text-[12px] text-slate-500"><LoaderCircle size={15} className="animate-spin text-violet-600" /> Loading your Jira issues…</div>
              ) : activeIssues.length === 0 && issues.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-6 text-center">
                  <p className="text-[12px] font-medium text-slate-700">No assigned tickets updated today</p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-400">Open Manage to refresh today’s ticket updates or search your assigned tickets.</p>
                </div>
              ) : activeIssues.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-7 text-center">
                  <div className="mx-auto mb-2 grid size-9 place-items-center rounded-xl bg-violet-50 text-violet-700"><ListPlus size={17} /></div>
                  <p className="text-[12px] font-semibold text-slate-700">Choose tickets for today</p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-400">{appState.showRecentTickets === false && hiddenRecentCount > 0 ? 'Recent tickets are hidden. Turn them on to see your selected tickets.' : 'Pick tickets from your updates or assigned work to add time.'}</p>
                  <button onClick={() => hiddenRecentCount > 0 && appState.showRecentTickets === false ? setAppState((current) => ({ ...current, showRecentTickets: true })) : openIssuePicker()} className="mt-3 rounded-lg bg-violet-700 px-3 py-2 text-[11px] font-semibold text-white transition hover:bg-violet-800">{hiddenRecentCount > 0 && appState.showRecentTickets === false ? 'Show recent tickets' : 'Select tickets'}</button>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {activeIssues.map((issue) => {
                    const draft = appState.drafts[issue.key];
                    const isAutoIssue = issue.key === autoIssueKey;
                    const remainingToLog = remainingMinutesPerIssue[issue.key] || 0;
                    const loggedMinutes = todayWorklogs.byIssue[issue.key] || 0;
                    const issueWorklogs = todayWorklogs.worklogsByIssue?.[issue.key] || [];
                    const latestWorklog = [...issueWorklogs].reverse().find((worklog) => worklog.description) || issueWorklogs.at(-1);
                    const excessMinutes = issue.estimateMinutes == null ? 0 : Math.max(0, loggedMinutes + remainingToLog - issue.estimateMinutes);
                    const issueIndex = activeIssues.findIndex((item) => item.key === issue.key);
                    const nextIssue = activeIssues.slice(issueIndex + 1).find((item) => item.key !== issue.key)
                      || activeIssues.slice(0, issueIndex).find((item) => item.key !== issue.key);
                    return (
                      <article key={issue.key} className={`rounded-xl border bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(16,24,40,.03)] ${loggedMinutes ? 'border-emerald-200' : 'border-slate-200'}`}>
                        <div className="mb-1.5 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-bold text-violet-700">{issue.key}</span>
                              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">Logged {formatDuration(loggedMinutes)}</span>
                              {isAutoIssue && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">Auto</span>}
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[12px] font-semibold leading-4 text-slate-700">{issue.title}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="text-[11px] font-semibold tabular-nums text-slate-500">{formatDuration(remainingToLog)} to log</span>
                            <button onClick={() => removeIssue(issue.key)} className="rounded p-0.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500" title="Remove ticket"><X size={13} /></button>
                          </div>
                        </div>
                        {excessMinutes > 0 && <div className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800">
                          <div className="flex items-start gap-1.5"><AlertCircle size={13} className="mt-0.5 shrink-0" /><span>Today’s time is {formatDuration(excessMinutes)} over this ticket’s estimate.</span></div>
                          {nextIssue ? <button onClick={() => moveExcess(issue.key, nextIssue.key, excessMinutes)} className="mt-1.5 ml-5 font-semibold text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-950">Move {formatDuration(excessMinutes)} to {nextIssue.key}</button> : <p className="mt-1 ml-5 text-amber-700">Add another ticket to move the extra time.</p>}
                        </div>}
                        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2">
                          <div className="min-w-0">
                            <label htmlFor={`worklog-hours-${issue.key}`} className="mb-1 flex items-center justify-between gap-1 text-[11px] font-medium text-slate-500"><span>Remaining to log</span><span>Estimate {issue.estimateMinutes == null ? '—' : formatDuration(issue.estimateMinutes)}</span></label>
                            <input id={`worklog-hours-${issue.key}`} aria-label={`Remaining time to log for ${issue.key}`} type="number" inputMode="decimal" min="0" max="24" step="0.25" value={draft.remainingHours ?? (draft.ticketHours !== undefined || draft.autoHours !== undefined ? formatHours(Math.max(0, parseMinutes(draft.ticketHours ?? draft.autoHours) - loggedMinutes)) : formatHours(remainingToLog))} disabled={busy} onChange={(event) => updateTicketHours(issue.key, event.target.value)} className={`h-10 w-full rounded-md border px-2 text-[14px] font-semibold tabular-nums outline-none focus:ring-2 disabled:opacity-60 ${isAutoIssue ? 'border-violet-200 bg-violet-50 text-violet-800 focus:border-violet-500 focus:ring-violet-200' : 'border-slate-200 bg-slate-50/70 text-slate-800 focus:border-violet-400 focus:bg-white focus:ring-violet-100'}`} />
                          </div>
                          <div className="min-w-0">
                          <label htmlFor={`worklog-description-${issue.key}`} className="mb-1 block text-[11px] font-medium text-slate-500">Description</label>
                          <textarea
                            id={`worklog-description-${issue.key}`}
                            value={draft.worklogDescription !== undefined ? draft.worklogDescription : latestWorklog?.description || draft.description || ''}
                            disabled={busy}
                            onChange={(event) => updateDraft(issue.key, (current) => ({ ...current, worklogDescription: event.target.value }))}
                            placeholder="Describe the work completed on this ticket"
                            rows={2}
                            style={{ fontSize: '12px' }}
                            className="h-10 min-h-10 w-full resize-y rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1 text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:bg-white focus:ring-1 focus:ring-violet-100 disabled:opacity-60"
                          />
                          </div>
                        </div>
                        {draft.submitError && <p className="mt-2 text-[11px] font-medium text-rose-600">{draft.submitError}</p>}
                      </article>
                    );
                  })}
                </div>
              )}

              {overCap && <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"><AlertCircle size={14} className="mt-0.5 shrink-0" /> Daily cap exceeded. Reduce entries or adjust your limit above.</div>}
            </div>

            <footer className="shrink-0 border-t border-slate-200 bg-white px-4 pb-3 pt-3">
              <button
                onClick={submitLogs}
                disabled={busy || pendingCount === 0 || pendingMinutes === 0 || overCap}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-700 text-[12px] font-semibold text-white shadow-[0_3px_7px_rgba(91,67,184,.2)] transition hover:bg-violet-800 disabled:bg-slate-300 disabled:shadow-none"
              >
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : pendingCount ? <ArrowRight size={15} /> : <CheckCircle2 size={15} />}
                {busy ? 'Working…' : pendingCount ? `Log time · ${formatDuration(pendingMinutes)}` : 'All entries logged'}
              </button>
              <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-slate-400"><ShieldCheck size={12} className="text-emerald-600" /> Your Jira credentials stay in this Chrome profile.</div>
            </footer>
          </section>
          {showIssuePicker && <IssuePicker issues={issues} drafts={appState.drafts} ownIssueKeys={appState.myOwnIssueKeys || []} loggedByIssue={todayWorklogs.byIssue} busy={busy} recentError={pageError} onRefreshRecent={() => loadIssues()} onSearchRecentIssues={(query) => getRecentIssues(appState.credentials, query)} onSearchMyIssues={(query) => searchMyOwnIssues(appState.credentials, query)} onToggle={toggleIssue} onClose={() => setShowIssuePicker(false)} />}
        </>
      )}
    </main>
  );
}

function IssuePicker({ issues, drafts, ownIssueKeys = [], loggedByIssue, busy, recentError, onRefreshRecent, onSearchRecentIssues, onSearchMyIssues, onToggle, onClose }) {
  const [mode, setMode] = useState('recent');
  const [query, setQuery] = useState('');
  const [ownIssues, setOwnIssues] = useState([]);
  const [recentSearchIssues, setRecentSearchIssues] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchMode, setSearchMode] = useState('');
  const [ownSearched, setOwnSearched] = useState(false);
  const [recentSearched, setRecentSearched] = useState(false);
  const [ownSearchError, setOwnSearchError] = useState('');
  const [recentSearchError, setRecentSearchError] = useState('');

  async function searchTickets(nextQuery = query, nextMode = mode) {
    setSearchBusy(true);
    setSearchMode(nextMode);
    if (nextMode === 'recent') setRecentSearchError('');
    else setOwnSearchError('');
    try {
      const results = await (nextMode === 'recent' ? onSearchRecentIssues(nextQuery) : onSearchMyIssues(nextQuery));
      if (nextMode === 'recent') {
        setRecentSearchIssues(results);
        setRecentSearched(true);
      } else {
        setOwnIssues(results);
        setOwnSearched(true);
      }
    } catch (error) {
      if (nextMode === 'recent') setRecentSearchError(error.message || 'Could not search today’s recent tickets.');
      else setOwnSearchError(error.message || 'Could not search your Jira tickets.');
    } finally {
      setSearchBusy(false);
      setSearchMode('');
    }
  }

  function chooseMode(nextMode) {
    setMode(nextMode);
    if (nextMode === 'own' && !ownSearched) searchTickets(query, 'own');
  }

  const visibleIssues = mode === 'recent' ? (recentSearched ? recentSearchIssues : issues) : ownIssues;
  const loading = mode === 'recent' ? busy || (searchBusy && searchMode === 'recent') : searchBusy && searchMode === 'own';
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-slate-950/35 p-3 sm:items-center sm:justify-center" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="issue-picker-title" className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3.5">
          <div><h2 id="issue-picker-title" className="text-[14px] font-semibold text-slate-800">Manage tickets</h2><p className="mt-0.5 text-[11px] text-slate-400">Choose recently updated or assigned tickets.</p></div>
          <button onClick={onClose} className="grid size-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" aria-label="Close ticket picker"><X size={16} /></button>
        </header>
        <div className="shrink-0 border-b border-slate-100 bg-white px-3 pt-2">
          <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1">
            <button onClick={() => chooseMode('recent')} className={`rounded-md px-2 py-2 text-[11px] font-semibold ${mode === 'recent' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}>Recent</button>
            <button onClick={() => chooseMode('own')} className={`rounded-md px-2 py-2 text-[11px] font-semibold ${mode === 'own' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}>My own</button>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); searchTickets(); }} className="flex gap-2 py-2">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by ticket ID or title" aria-label="Search by ticket ID or title" className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 text-[11px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" />
            <button type="submit" disabled={searchBusy} className="flex h-9 items-center gap-1 rounded-lg bg-violet-700 px-2.5 text-[10px] font-semibold text-white disabled:opacity-60">{searchBusy && searchMode === mode ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />} Search</button>
          </form>
          {mode === 'recent' && <div className="flex justify-end pb-1.5"><button onClick={() => { setRecentSearched(false); setRecentSearchError(''); setQuery(''); onRefreshRecent(); }} disabled={busy} className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Refresh recent list</button></div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-soft">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-slate-500"><LoaderCircle size={15} className="animate-spin text-violet-600" /> {mode === 'recent' ? 'Loading today’s updates…' : 'Searching your tickets…'}</div>
          ) : (mode === 'own' && ownSearchError) || (mode === 'recent' && (recentSearchError || (recentError && !recentSearched))) ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-4 text-rose-700">{mode === 'own' ? ownSearchError : recentSearchError || recentError}</div>
          ) : visibleIssues.length === 0 ? (
            <p className="px-3 py-8 text-center text-[12px] text-slate-500">{mode === 'recent' ? 'No assigned tickets were updated today.' : 'No assigned tickets found. Try another search.'}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {visibleIssues.map((issue) => {
                const draft = drafts[issue.key];
                const selected = Boolean(draft);
                const loggedMinutes = loggedByIssue[issue.key] || 0;
                const prioritized = ownIssueKeys.includes(issue.key);
                return (
                  <button
                    key={issue.key}
                    onClick={() => onToggle(issue, mode)}
                    aria-pressed={selected}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${selected ? 'border-violet-200 bg-violet-50/70' : 'border-slate-200 bg-white hover:border-violet-200'}`}
                  >
                    <span className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] border ${selected ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-300 bg-white'}`}>{selected && <Check size={12} strokeWidth={3} />}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold text-slate-700">{issue.title}</span><span className="mt-0.5 block text-[10px] text-slate-400"><b className="font-semibold text-violet-700">{issue.key}</b> · {issue.type}</span></span>
                    {prioritized && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700">First</span>}
                    {loggedMinutes > 0 && <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-emerald-700"><CheckCircle2 size={12} /> {formatDuration(loggedMinutes)}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <footer className="flex shrink-0 items-center justify-between border-t border-slate-100 px-4 py-3">
          <span className="text-[11px] text-slate-400">{Object.keys(drafts).length} selected</span>
          <button onClick={onClose} className="rounded-lg bg-violet-700 px-3.5 py-2 text-[11px] font-semibold text-white transition hover:bg-violet-800">Done</button>
        </footer>
      </section>
    </div>
  );
}

function ThemeSelect({ theme, onChange }) {
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 text-slate-500 shadow-sm">
      <ThemeIcon size={14} />
      <select aria-label="Color theme" value={theme} onChange={(event) => onChange(event.target.value)} className="max-w-[76px] cursor-pointer bg-transparent text-[10px] font-semibold text-slate-600 outline-none">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function Header({ theme, onThemeChange, onSettings }) {
  return (
    <header className="flex h-[54px] items-center justify-between border-b border-slate-200/80 bg-white px-5">
      <div className="flex items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-lg bg-violet-700 text-white shadow-sm"><Clock3 size={15} strokeWidth={2.2} /></div>
        <div><div className="text-[12px] font-bold tracking-[-0.02em] text-slate-800">jira<span className="text-violet-700">time</span></div><div className="text-[9px] font-medium text-slate-400">BULK LOGGER</div></div>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-semibold text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-500" /> Connected</span>
        <ThemeSelect theme={theme} onChange={onThemeChange} />
        <button onClick={onSettings} className="grid size-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" title="Jira connection settings"><Settings2 size={15} /></button>
      </div>
    </header>
  );
}

function DailyProgress({ total, cap, remaining, capValue, onChange }) {
  const progress = Math.min(100, (total / cap) * 100);
  const progressColor = total >= cap ? 'bg-green-500' : total <= 120 ? 'bg-red-500' : total <= 240 ? 'bg-yellow-400' : 'bg-blue-500';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(capValue));
  const commit = () => { onChange(value); setEditing(false); };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_2px_7px_rgba(16,24,40,.03)]">
      <div className="flex items-start justify-between">
        <div><p className="text-[11px] font-medium text-slate-400">Logged time</p><p className="mt-0.5 text-[26px] font-semibold leading-tight tracking-[-0.05em] text-slate-900">{formatDuration(total)} <span className="text-[13px] font-medium tracking-normal text-slate-400">/ {capValue}h</span></p></div>
        <div className="flex items-center gap-1 rounded-full bg-violet-50 px-2 py-1 text-[10px] font-semibold text-violet-700"><Clock3 size={11} /> {formatDuration(remaining)} left</div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-300 ${progressColor}`} style={{ width: `${progress}%` }} /></div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400"><span>Daily target</span>
        {editing ? <span className="flex items-center gap-1"><input type="number" min="0.25" max="24" step="0.25" value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && commit()} className="w-12 rounded border border-slate-200 px-1 py-0.5 text-right text-slate-700 outline-none focus:border-violet-400" autoFocus /><span>h</span><button onClick={commit} className="ml-1 font-semibold text-violet-700">Save</button><button onClick={() => setEditing(false)} className="text-slate-400"><X size={12} /></button></span> : <button onClick={() => { setValue(String(capValue)); setEditing(true); }} className="font-semibold text-slate-500 hover:text-violet-700">Edit limit</button>}
      </div>
    </div>
  );
}

function WellDoneBanner() {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-emerald-800">
      <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
      <div><p className="text-[12px] font-semibold">Well done!</p><p className="mt-0.5 text-[10px] leading-4 text-emerald-700">You reached your daily logged-time target. No more reminders today.</p></div>
    </div>
  );
}

function ReminderBanner({ source, snoozeMinutes, onSnooze }) {
  return (
    <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
      <div className="flex items-start gap-2.5">
        <Clock3 size={17} className="mt-0.5 shrink-0 text-violet-700" />
        <div className="min-w-0 flex-1"><p className="text-[13px] font-semibold text-violet-900">Time to log your Jira work</p><p className="mt-1 text-[11px] leading-4 text-violet-700">{source === 'snooze' ? 'Your snoozed reminder is back.' : 'Your daily reminder is here.'}</p></div>
      </div>
      <button onClick={onSnooze} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-violet-700 px-4 text-[12px] font-semibold text-white shadow-sm transition hover:bg-violet-800 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:ring-offset-2"><Clock3 size={15} /> Snooze for {snoozeMinutes} minutes</button>
    </div>
  );
}

function SnoozedBanner({ message }) {
  return <div className="mb-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-[10px] leading-4 text-slate-600"><Clock3 size={14} className="mt-0.5 shrink-0 text-violet-600" />{message}</div>;
}

function InlineAlert({ message }) {
  return <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[11px] leading-4 text-rose-700"><AlertCircle size={14} className="mt-0.5 shrink-0" />{message}</div>;
}

function SetupScreen({ form, setForm, theme, onThemeChange, showToken, setShowToken, error, busy, onSubmit, existing, onBack }) {
  return (
    <div className="animate-enter h-full overflow-y-auto px-6 pb-6 pt-5 scrollbar-soft">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5"><div className="grid size-8 place-items-center rounded-xl bg-violet-700 text-white"><Clock3 size={17} /></div><div><p className="text-[13px] font-bold text-slate-800">Jira Timekeeper</p><p className="text-[10px] text-slate-400">Bulk log your workday</p></div></div>
        <div className="flex items-center gap-1.5">
          {existing && <button onClick={onBack} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100"><ArrowLeft size={13} /> Back</button>}
        </div>
      </header>
      <div className="mb-3 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-600">Appearance</span>
        <ThemeSelect theme={theme} onChange={onThemeChange} />
      </div>
      <div className="setup-info-panel mb-4 rounded-2xl border p-4">
        <div className="mb-2 flex items-center gap-2 text-violet-700"><LockKeyhole size={15} /><span className="text-[11px] font-semibold">Connect your Jira Cloud</span></div>
        <ol className="list-inside list-decimal space-y-1 text-[11px] leading-[16px] text-slate-600">
          <li>Enter your Jira site address, such as <span className="font-medium">your-team.atlassian.net</span>, and your Atlassian account email.</li>
          <li>Create an API token with the link below and paste it here.</li>
          <li>Select <span className="font-semibold">Connect to Jira</span>, then allow access to your Jira site when your browser asks.</li>
        </ol>
        <p className="mt-2 text-[10px] leading-4 text-slate-500">Your token is stored in this browser profile and sent directly to your Jira site. No hosted service is used.</p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Jira site URL" placeholder="your-team.atlassian.net" value={form.site} onChange={(value) => setForm((current) => ({ ...current, site: value }))} autoComplete="url" />
        <Field label="Atlassian account email" placeholder="you@company.com" type="email" value={form.email} onChange={(value) => setForm((current) => ({ ...current, email: value }))} autoComplete="email" />
        <div><label className="mb-1.5 block text-[10px] font-semibold text-slate-600">API token</label><div className="relative"><input type={showToken ? 'text' : 'password'} required autoComplete="off" value={form.token} onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))} placeholder="Paste your Atlassian API token" className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 pr-14 text-[12px] outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /><button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 hover:text-violet-700">{showToken ? 'Hide' : 'Show'}</button></div><a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 hover:text-violet-900">Create an API token <ExternalLink size={10} /></a></div>
        {error && <InlineAlert message={error} />}
        <button type="submit" disabled={busy} className="mt-1 flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-700 text-[12px] font-semibold text-white shadow-[0_3px_7px_rgba(91,67,184,.2)] transition hover:bg-violet-800 disabled:opacity-60">{busy ? <><LoaderCircle size={15} className="animate-spin" /> Connecting…</> : <>Connect to Jira <ArrowRight size={15} /></>}</button>
      </form>
      <div className="mt-4 flex items-start gap-2 rounded-xl bg-slate-100/80 px-3 py-2.5"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" /><p className="text-[10px] leading-4 text-slate-500">Use an API token created for this extension. You can disconnect and clear it any time.</p></div>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, type = 'text', autoComplete }) {
  return <div><label className="mb-1.5 block text-[10px] font-semibold text-slate-600">{label}</label><input type={type} required autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-[12px] outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /></div>;
}

function SettingsPage({ cap, reminderSettings, form, setForm, showToken, setShowToken, connectionError, busy, onSaveCap, onSaveReminderSettings, onSaveConnection, onBack, onDisconnect }) {
  const [tab, setTab] = useState('daily');
  const [value, setValue] = useState(String(cap));
  const [reminders, setReminders] = useState({ ...DEFAULT_REMINDER_SETTINGS, ...(reminderSettings || {}) });
  const [capError, setCapError] = useState('');
  const [reminderSaved, setReminderSaved] = useState(false);
  const saveDailyTarget = () => {
    if (!value || Number(value) < 0.25 || Number(value) > 24) {
      setCapError('Enter a daily target between 0.25 and 24 hours.');
      return;
    }
    onSaveCap(value);
    setCapError('');
  };
  const saveReminders = () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminders.dailyTime)) return;
    onSaveReminderSettings(reminders);
    setReminderSaved(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f7f8fa]">
      <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white px-4">
        <button onClick={onBack} className="grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Back to time logger"><ArrowLeft size={16} /></button>
        <div><h1 className="text-[13px] font-bold text-slate-800">Settings</h1><p className="text-[10px] text-slate-400">Manage your daily target and Jira account</p></div>
      </header>
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4" aria-label="Settings sections">
        <button onClick={() => setTab('daily')} className={`shrink-0 border-b-2 px-3 py-3 text-[11px] font-semibold ${tab === 'daily' ? 'border-violet-700 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>Daily settings</button>
        <button onClick={() => setTab('reminders')} className={`shrink-0 border-b-2 px-3 py-3 text-[11px] font-semibold ${tab === 'reminders' ? 'border-violet-700 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>Reminders</button>
        <button onClick={() => setTab('jira')} className={`shrink-0 border-b-2 px-3 py-3 text-[11px] font-semibold ${tab === 'jira' ? 'border-violet-700 text-violet-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>Jira connection</button>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-soft">
        {tab === 'daily' ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_2px_7px_rgba(16,24,40,.03)]">
            <div className="mb-4 flex items-center gap-2"><Clock3 size={16} className="text-violet-700" /><div><h2 className="text-[12px] font-semibold text-slate-800">Daily time target</h2><p className="text-[10px] text-slate-400">Default is 8 hours per day.</p></div></div>
            <label className="mb-1.5 block text-[10px] font-semibold text-slate-600" htmlFor="daily-target">Hours per day</label>
            <div className="flex items-center gap-2"><input id="daily-target" type="number" min="0.25" max="24" step="0.25" value={value} onChange={(event) => setValue(event.target.value)} className="h-10 w-28 rounded-lg border border-slate-200 px-3 text-[12px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /><span className="text-[11px] text-slate-400">hours (0.25–24)</span></div>
            {capError && <p className="mt-2 text-[10px] font-medium text-rose-600">{capError}</p>}
            <button onClick={saveDailyTarget} className="mt-4 rounded-lg bg-violet-700 px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-violet-800">Save daily target</button>
          </section>
        ) : tab === 'reminders' ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_2px_7px_rgba(16,24,40,.03)]">
            <div className="mb-4 flex items-center gap-2"><Clock3 size={16} className="text-violet-700" /><div><h2 className="text-[12px] font-semibold text-slate-800">Auto-open reminder</h2><p className="text-[10px] text-slate-400">Open Timekeeper at a daily time until logs are complete.</p></div></div>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-3">
              <span><span className="block text-[11px] font-semibold text-slate-700">Enable auto-open</span><span className="mt-0.5 block text-[10px] text-slate-400">Open a Timekeeper tab when your reminder is due.</span></span>
              <input type="checkbox" checked={reminders.enabled} onChange={(event) => { setReminders((current) => ({ ...current, enabled: event.target.checked })); setReminderSaved(false); }} className="size-4 accent-violet-700" />
            </label>
            <div className="mt-4 grid grid-cols-1 gap-3">
              <div><label htmlFor="reminder-time" className="mb-1.5 block text-[10px] font-semibold text-slate-600">Open Timekeeper every day at</label><input id="reminder-time" type="time" value={reminders.dailyTime} onChange={(event) => { setReminders((current) => ({ ...current, dailyTime: event.target.value })); setReminderSaved(false); }} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-[12px] text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /></div>
              <div><label htmlFor="snooze-minutes" className="mb-1.5 block text-[10px] font-semibold text-slate-600">Snooze for</label><select id="snooze-minutes" value={reminders.snoozeMinutes} onChange={(event) => { setReminders((current) => ({ ...current, snoozeMinutes: Number(event.target.value) })); setReminderSaved(false); }} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100">{[5, 10, 15, 20, 30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></div>
            </div>
            <p className="mt-3 text-[10px] leading-4 text-slate-400">If you snooze, a new Timekeeper tab opens after this delay. Reminders stop when today’s logged hours reach your daily target.</p>
            {reminderSaved && <p className="mt-3 text-[10px] font-semibold text-emerald-700">Reminder settings saved.</p>}
            <button onClick={saveReminders} className="mt-4 rounded-lg bg-violet-700 px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-violet-800">Save reminder settings</button>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_2px_7px_rgba(16,24,40,.03)]">
              <div className="mb-4 flex items-center gap-2"><LockKeyhole size={15} className="text-violet-700" /><div><h2 className="text-[12px] font-semibold text-slate-800">Jira connection</h2><p className="text-[10px] text-slate-400">Update the site or credentials used to fetch tickets.</p></div></div>
              <form onSubmit={onSaveConnection} className="flex flex-col gap-3">
                <Field label="Jira site URL" placeholder="your-team.atlassian.net" value={form.site} onChange={(site) => setForm((current) => ({ ...current, site }))} autoComplete="url" />
                <Field label="Atlassian account email" placeholder="you@company.com" type="email" value={form.email} onChange={(email) => setForm((current) => ({ ...current, email }))} autoComplete="email" />
                <div><label className="mb-1.5 block text-[10px] font-semibold text-slate-600">API token</label><div className="relative"><input type={showToken ? 'text' : 'password'} required autoComplete="off" value={form.token} onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))} placeholder="Paste your Atlassian API token" className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 pr-14 text-[12px] outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /><button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 hover:text-violet-700">{showToken ? 'Hide' : 'Show'}</button></div><a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 hover:text-violet-900">Create an API token <ExternalLink size={10} /></a></div>
                {connectionError && <InlineAlert message={connectionError} />}
                <button type="submit" disabled={busy} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-700 text-[11px] font-semibold text-white transition hover:bg-violet-800 disabled:opacity-60">{busy ? <><LoaderCircle size={14} className="animate-spin" /> Saving connection…</> : <>Save and verify connection <ArrowRight size={14} /></>}</button>
              </form>
              <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-slate-400"><ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-600" />Credentials are stored in this Chrome profile and sent directly to Jira.</p>
            </section>
            <button onClick={onDisconnect} className="self-start rounded-lg px-2 py-2 text-[10px] font-semibold text-rose-600 hover:bg-rose-50">Disconnect and clear local data</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
