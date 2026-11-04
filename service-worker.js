const STATE_KEY = 'jiraBulkLoggerState';
const COMPLETION_KEY = 'jiraTimekeeperCompletedDay';
const REMINDER_TAB_KEY = 'jiraTimekeeperReminderTabId';
const DAILY_ALARM = 'jira-timekeeper-daily-reminder';
const SNOOZE_ALARM = 'jira-timekeeper-snooze-reminder';
const DEFAULT_REMINDER_SETTINGS = { enabled: false, dailyTime: '16:00', snoozeMinutes: 15 };

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localDateAt(time, base = new Date()) {
  const [hours, minutes] = String(time || '16:00').split(':').map(Number);
  const date = new Date(base);
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

function promiseCall(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function getLocal(keys) {
  return promiseCall(chrome.storage.local.get.bind(chrome.storage.local), keys);
}

function setLocal(values) {
  return promiseCall(chrome.storage.local.set.bind(chrome.storage.local), values);
}

function getSession(keys) {
  return promiseCall(chrome.storage.session.get.bind(chrome.storage.session), keys);
}

function setSession(values) {
  return promiseCall(chrome.storage.session.set.bind(chrome.storage.session), values);
}

function clearAlarm(name) {
  return promiseCall(chrome.alarms.clear.bind(chrome.alarms), name);
}

function createAlarm(name, info) {
  return Promise.resolve(chrome.alarms.create(name, info));
}

function notifyExtensionPages(message) {
  chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
}

function reminderSettingsFrom(data) {
  return { ...DEFAULT_REMINDER_SETTINGS, ...(data[STATE_KEY]?.reminderSettings || {}) };
}

async function isCompleteToday(data) {
  return data[COMPLETION_KEY] === todayKey();
}

async function markCompleteToday() {
  const day = todayKey();
  const data = await getLocal([COMPLETION_KEY, STATE_KEY]);
  if (data[COMPLETION_KEY] !== day) return false;
  await clearAlarm(SNOOZE_ALARM);
  const settings = reminderSettingsFrom(data);
  if (settings.enabled) {
    await scheduleDailyForNextDay(settings.dailyTime);
  } else {
    await clearAlarm(DAILY_ALARM);
  }
  notifyExtensionPages({ type: 'JIRA_LOGS_COMPLETED', day });
  return true;
}

async function scheduleDailyForNextDay(time) {
  const next = localDateAt(time);
  next.setDate(next.getDate() + 1);
  await clearAlarm(DAILY_ALARM);
  await createAlarm(DAILY_ALARM, { when: next.getTime() });
}

async function scheduleFromSettings() {
  const data = await getLocal([STATE_KEY, COMPLETION_KEY]);
  const settings = reminderSettingsFrom(data);
  if (!settings.enabled) {
    await Promise.all([clearAlarm(DAILY_ALARM), clearAlarm(SNOOZE_ALARM)]);
    return;
  }

  if (await isCompleteToday(data)) {
    await markCompleteToday();
    return;
  }

  await clearAlarm(DAILY_ALARM);
  const next = localDateAt(settings.dailyTime);
  if (next.getTime() <= Date.now()) {
    // Chrome's alarm minimum is 30 seconds. This also gives restored tabs
    // time to register before an overdue reminder opens.
    next.setTime(Date.now() + 30_000);
  }
  await createAlarm(DAILY_ALARM, { when: next.getTime() });
}

async function openReminderTab(source, alwaysNew = false) {
  const url = `${chrome.runtime.getURL('index.html')}?full=1&reminder=${encodeURIComponent(source)}`;
  if (!alwaysNew) {
    const saved = await getSession(REMINDER_TAB_KEY);
    if (Number.isInteger(saved[REMINDER_TAB_KEY])) {
      try {
        const existing = await promiseCall(chrome.tabs.get.bind(chrome.tabs), saved[REMINDER_TAB_KEY]);
        if (existing?.id != null) {
          await promiseCall(chrome.tabs.update.bind(chrome.tabs), existing.id, { active: true });
          notifyExtensionPages({ type: 'JIRA_REMINDER_TRIGGERED', source, tabId: existing.id });
          return existing.id;
        }
      } catch { /* The tracked Timekeeper tab was closed. */ }
    }
  }

  const tab = await promiseCall(chrome.tabs.create.bind(chrome.tabs), { url, active: true });
  if (Number.isInteger(tab?.id)) await setSession({ [REMINDER_TAB_KEY]: tab.id });
  return tab?.id;
}

async function handleDailyAlarm() {
  const data = await getLocal([STATE_KEY, COMPLETION_KEY]);
  const settings = reminderSettingsFrom(data);
  if (!settings.enabled) return;
  if (await isCompleteToday(data)) {
    await markCompleteToday();
    return;
  }
  await openReminderTab('daily');
  await scheduleDailyForNextDay(settings.dailyTime);
}

async function handleSnoozeAlarm() {
  const data = await getLocal([STATE_KEY, COMPLETION_KEY]);
  const settings = reminderSettingsFrom(data);
  if (!settings.enabled) return;
  if (await isCompleteToday(data)) {
    await markCompleteToday();
    return;
  }
  await openReminderTab('snooze', true);
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== 'number') return;

  chrome.sidePanel.setOptions({ tabId: tab.id, path: 'index.html', enabled: true }, () => {
    if (chrome.runtime.lastError) {
      console.error('Could not configure Jira Timekeeper for this tab:', chrome.runtime.lastError.message);
      return;
    }
    chrome.sidePanel.open({ tabId: tab.id }, () => {
      if (chrome.runtime.lastError) console.error('Could not open Jira Timekeeper for this tab:', chrome.runtime.lastError.message);
    });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) handleDailyAlarm().catch((error) => console.error('Daily reminder failed:', error));
  if (alarm.name === SNOOZE_ALARM) handleSnoozeAlarm().catch((error) => console.error('Snoozed reminder failed:', error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'JIRA_REGISTER_REMINDER_TAB' && Number.isInteger(message.tabId)) {
    setSession({ [REMINDER_TAB_KEY]: message.tabId }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'JIRA_SNOOZE_REMINDER') {
    (async () => {
      const data = await getLocal([STATE_KEY, COMPLETION_KEY]);
      const settings = reminderSettingsFrom(data);
      if (!settings.enabled || await isCompleteToday(data)) {
        sendResponse({ ok: false, message: 'Today’s logs are complete or reminders are turned off.' });
        return;
      }
      const snoozeMinutes = Math.min(240, Math.max(1, Number(settings.snoozeMinutes) || 15));
      await createAlarm(SNOOZE_ALARM, { delayInMinutes: snoozeMinutes });
      sendResponse({ ok: true, snoozeMinutes });
    })().catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STATE_KEY]) {
    const oldSettings = { ...DEFAULT_REMINDER_SETTINGS, ...(changes[STATE_KEY].oldValue?.reminderSettings || {}) };
    const newSettings = { ...DEFAULT_REMINDER_SETTINGS, ...(changes[STATE_KEY].newValue?.reminderSettings || {}) };
    if (JSON.stringify(oldSettings) !== JSON.stringify(newSettings)) {
      scheduleFromSettings().catch((error) => console.error('Could not schedule Jira reminders:', error));
    }
  }
  if (changes[COMPLETION_KEY]?.newValue === todayKey()) {
    markCompleteToday().catch((error) => console.error('Could not stop Jira reminders after completion:', error));
  }
});

chrome.runtime.onStartup.addListener(() => {
  scheduleFromSettings().catch((error) => console.error('Could not restore Jira reminders:', error));
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleFromSettings().catch((error) => console.error('Could not initialize Jira reminders:', error));
});
