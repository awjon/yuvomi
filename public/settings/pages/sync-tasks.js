import { api } from '/api.js';
import { formatDate, formatTime, t } from '/i18n.js';

function formatSyncTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${formatDate(date)} ${formatTime(date)}`.trim();
}

function showToast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

function connectionStatusText(status) {
  if (!status?.configured) return t('settings.notConfigured');
  if (!status.connected) return t('settings.notConnected');
  const formatted = formatSyncTime(status.lastSync);
  return formatted ? t('settings.connectedLastSync', { date: formatted }) : t('settings.connected');
}

export async function render(container, { user } = {}) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.googleTasksTitle')}</h2>
      <div class="settings-card" id="google-tasks-card">
        <p class="settings-card-description">${t('settings.googleTasksDescription')}</p>
        <p class="settings-sync-info__status" id="google-tasks-status">${t('common.loading')}</p>
        <div id="google-tasks-body"></div>
      </div>
    </section>
  `);

  const body = container.querySelector('#google-tasks-body');
  const statusEl = container.querySelector('#google-tasks-status');

  let status;
  try {
    status = await api.get('/tasks/google/status');
  } catch (err) {
    statusEl.textContent = err.message || t('common.errorGeneric');
    return;
  }

  statusEl.textContent = connectionStatusText(status);

  if (!status.configured) {
    body.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.googleTasksSetupHint')}</p>`);
    window.lucide?.createIcons({ el: container });
    return;
  }

  if (!status.connected) {
    body.insertAdjacentHTML('beforeend',
      `<p class="form-hint">${t('settings.googleTasksConnectHint')}</p>`);
    if (user?.role === 'admin') {
      const link = document.createElement('a');
      link.href = '/api/v1/calendar/google/auth';
      link.className = 'btn btn--primary';
      link.textContent = t('settings.connectGoogle');
      body.appendChild(link);
    }
    window.lucide?.createIcons({ el: container });
    return;
  }

  // Verbunden, aber Tasks-Scope fehlt → erneut verbinden.
  if (status.needsReconsent) {
    body.insertAdjacentHTML('beforeend',
      `<p class="form-hint">${t('settings.googleReconsentHint')}</p>`);
    if (user?.role === 'admin') {
      const link = document.createElement('a');
      link.href = '/api/v1/calendar/google/auth';
      link.className = 'btn btn--primary';
      link.textContent = t('settings.googleReconnect');
      body.appendChild(link);
    }
    window.lucide?.createIcons({ el: container });
    return;
  }

  if (user?.role !== 'admin') {
    body.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.googleOnlyAdmin')}</p>`);
    window.lucide?.createIcons({ el: container });
    return;
  }

  // Task-Listen-Auswahl
  const listGroup = document.createElement('div');
  listGroup.className = 'form-group';
  listGroup.insertAdjacentHTML('beforeend',
    `<label class="form-label">${t('settings.googleTasklistsSelect')}</label>`);
  const list = document.createElement('div');
  list.className = 'google-tasklists-list';
  list.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('common.loading')}</p>`);
  listGroup.appendChild(list);
  listGroup.insertAdjacentHTML('beforeend',
    `<p class="form-hint">${t('settings.googleTasklistsSelectHint')}</p>`);
  body.appendChild(listGroup);

  async function loadTasklists() {
    try {
      const { data } = await api.get('/tasks/google/tasklists');
      list.replaceChildren();
      if (!data || data.length === 0) {
        list.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.googleTasklistsEmpty')}</p>`);
        return;
      }
      for (const tl of data) {
        const item = document.createElement('label');
        item.className = 'toggle-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!tl.enabled;
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          try {
            await api.patch('/tasks/google/tasklists', { tasklistId: tl.id, enabled: checkbox.checked, name: tl.title });
            showToast(t('settings.syncSuccess', { provider: 'Google Tasks' }), 'success');
          } catch (err) {
            checkbox.checked = !checkbox.checked;
            showToast(err.message || t('common.errorGeneric'), 'danger');
          } finally {
            checkbox.disabled = false;
          }
        });
        const span = document.createElement('span');
        span.textContent = tl.title;
        item.append(checkbox, span);
        list.appendChild(item);
      }
    } catch (err) {
      list.replaceChildren();
      list.insertAdjacentHTML('beforeend', `<p class="form-error">${err.message || t('common.errorGeneric')}</p>`);
    }
  }
  await loadTasklists();

  // Aktionen
  const actions = document.createElement('div');
  actions.className = 'settings-sync-actions';
  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn btn--secondary';
  syncBtn.textContent = t('settings.syncNow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = t('settings.synchronizing');
    try {
      await api.post('/tasks/google/sync', {});
      showToast(t('settings.syncSuccess', { provider: 'Google Tasks' }), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = t('settings.syncNow');
    }
  });
  actions.appendChild(syncBtn);
  body.appendChild(actions);

  window.lucide?.createIcons({ el: container });
}
