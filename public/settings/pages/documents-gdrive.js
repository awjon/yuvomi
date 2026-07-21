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
      <h2 class="settings-section__title">${t('settings.gdriveTitle')}</h2>
      <div class="settings-card">
        <p class="settings-card-description">${t('settings.gdriveDescription')}</p>
        <p class="settings-sync-info__status" id="gdrive-status">${t('common.loading')}</p>
        <div id="gdrive-body"></div>
      </div>
    </section>
  `);

  const body = container.querySelector('#gdrive-body');
  const statusEl = container.querySelector('#gdrive-status');

  let status;
  try {
    status = await api.get('/documents/gdrive/status');
  } catch (err) {
    statusEl.textContent = err.message || t('common.errorGeneric');
    return;
  }
  statusEl.textContent = connectionStatusText(status);

  if (!status.configured) {
    body.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.gdriveSetupHint')}</p>`);
    window.lucide?.createIcons({ el: container });
    return;
  }

  if (!status.connected || status.needsReconsent) {
    const hintKey = status.needsReconsent ? 'settings.googleReconsentHint' : 'settings.gdriveConnectHint';
    const linkKey = status.needsReconsent ? 'settings.googleReconnect' : 'settings.connectGoogle';
    body.insertAdjacentHTML('beforeend', `<p class="form-hint">${t(hintKey)}</p>`);
    if (user?.role === 'admin') {
      const link = document.createElement('a');
      link.href = '/api/v1/calendar/google/auth';
      link.className = 'btn btn--primary';
      link.textContent = t(linkKey);
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

  // Ordner-Browser (eine Ebene)
  const folderGroup = document.createElement('div');
  folderGroup.className = 'form-group';
  folderGroup.insertAdjacentHTML('beforeend', `<label class="form-label">${t('settings.gdriveFoldersSelect')}</label>`);
  const list = document.createElement('div');
  list.className = 'gdrive-folders-list';
  list.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('common.loading')}</p>`);
  folderGroup.appendChild(list);
  folderGroup.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.gdriveFoldersSelectHint')}</p>`);
  body.appendChild(folderGroup);

  async function loadFolders() {
    try {
      const { data } = await api.get('/documents/gdrive/folders');
      list.replaceChildren();
      if (!data || data.length === 0) {
        list.insertAdjacentHTML('beforeend', `<p class="form-hint">${t('settings.gdriveFoldersEmpty')}</p>`);
        return;
      }
      for (const folder of data) {
        const item = document.createElement('label');
        item.className = 'toggle-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!folder.enabled;
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          try {
            await api.patch('/documents/gdrive/folders', { folderId: folder.id, enabled: checkbox.checked, name: folder.name });
            showToast(t('settings.syncSuccess', { provider: 'Google Drive' }), 'success');
          } catch (err) {
            checkbox.checked = !checkbox.checked;
            showToast(err.message || t('common.errorGeneric'), 'danger');
          } finally {
            checkbox.disabled = false;
          }
        });
        const span = document.createElement('span');
        span.textContent = folder.name;
        item.append(checkbox, span);
        list.appendChild(item);
      }
    } catch (err) {
      list.replaceChildren();
      list.insertAdjacentHTML('beforeend', `<p class="form-error">${err.message || t('common.errorGeneric')}</p>`);
    }
  }
  await loadFolders();

  // Upload-Backend
  const uploadGroup = document.createElement('div');
  uploadGroup.className = 'form-group';
  uploadGroup.insertAdjacentHTML('beforeend', `
    <label class="toggle-row">
      <input type="checkbox" id="gdrive-upload-toggle" ${status.upload?.enabled ? 'checked' : ''} />
      <span>${t('settings.gdriveUploadToggle')}</span>
    </label>
    <div class="form-group" id="gdrive-upload-folder-wrap" ${status.upload?.enabled ? '' : 'hidden'}>
      <label class="form-label" for="gdrive-upload-folder">${t('settings.gdriveUploadFolder')}</label>
      <input class="form-input" type="text" id="gdrive-upload-folder-id" placeholder="${t('settings.gdriveUploadFolderIdPlaceholder')}"
             value="${status.upload?.folderId ? String(status.upload.folderId).replace(/"/g, '&quot;') : ''}" />
      <p class="form-hint">${t('settings.gdriveUploadHint')}</p>
    </div>
    <div class="settings-form-actions">
      <button type="button" class="btn btn--primary" id="gdrive-upload-save">${t('common.save')}</button>
    </div>
  `);
  body.appendChild(uploadGroup);

  const uploadToggle = uploadGroup.querySelector('#gdrive-upload-toggle');
  const uploadWrap = uploadGroup.querySelector('#gdrive-upload-folder-wrap');
  uploadToggle.addEventListener('change', () => { uploadWrap.hidden = !uploadToggle.checked; });
  uploadGroup.querySelector('#gdrive-upload-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.put('/documents/gdrive/config', {
        enabled: uploadToggle.checked,
        folder_id: uploadGroup.querySelector('#gdrive-upload-folder-id').value.trim() || null,
      });
      showToast(t('documents.savedToast'), 'success');
    } catch (err) {
      showToast(err.message || t('common.errorGeneric'), 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  // Sync now
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
      await api.post('/documents/gdrive/sync', {});
      showToast(t('settings.syncSuccess', { provider: 'Google Drive' }), 'success');
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
