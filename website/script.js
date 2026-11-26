const repository = 'THESuiseiCOMET/KNode';
const releaseDownloads = 'https://github.com/' + repository + '/releases/download/';
const githubDownload = document.querySelector('#github-download');
const version = document.querySelector('#version');
const lanzouDownload = document.querySelector('#lanzou-download');
const copyStatus = document.querySelector('#copy-status');
const lanzouPassword = document.querySelector('#lanzou-password').textContent;

async function loadLatestRelease() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch('https://api.github.com/repos/' + repository + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });

    if (!response.ok) return;

    const release = await response.json();
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) return;
    if (typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/i.test(release.tag_name)) return;

    const installer = release.assets.find((asset) =>
      /^KNode_.+_x64-setup\.exe$/i.test(asset.name) &&
      typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.startsWith(releaseDownloads),
    );

    if (installer) {
      githubDownload.href = installer.browser_download_url;
      version.textContent = 'v' + release.tag_name.replace(/^v/i, '');
    }
  } catch {
    // Keep the working v1.0.0 download already present in the page.
  } finally {
    window.clearTimeout(timeout);
  }
}

function copyWithSelection(text) {
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.className = 'clipboard-buffer';
  document.body.append(field);

  try {
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

async function copyLanzouPassword() {
  try {
    await navigator.clipboard.writeText(lanzouPassword);
    return true;
  } catch {
    return copyWithSelection(lanzouPassword);
  }
}

let statusTimeout;
lanzouDownload.addEventListener('click', async () => {
  const copied = await copyLanzouPassword();
  copyStatus.textContent = copied ? '提取码已复制' : '复制失败，请手动复制提取码';
  window.clearTimeout(statusTimeout);
  statusTimeout = window.setTimeout(() => {
    copyStatus.textContent = '';
  }, copied ? 2000 : 4000);
});

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function typeText(slot, interval) {
  const value = [...slot.querySelector('.type-value').textContent];
  const text = slot.querySelector('.type-text');
  for (const [index, letter] of value.entries()) {
    if (index > 0) await delay(interval);
    text.textContent += letter;
  }
}

async function typeBrand(releaseReady) {
  const page = document.documentElement;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    page.classList.remove('typing-pending');
    return;
  }

  const brand = document.querySelector('.brand');
  const title = brand.querySelector('h1');
  const versionSlot = brand.querySelector('.version');
  const titleCaret = title.querySelector('.type-caret');
  const versionCaret = versionSlot.querySelector('.type-caret');
  titleCaret.textContent = '_';
  versionCaret.textContent = '_';
  versionSlot.style.inlineSize = versionSlot.getBoundingClientRect().width + 'px';
  brand.classList.add('is-typing');
  page.classList.remove('typing-pending');

  try {
    titleCaret.hidden = false;
    await delay(300);
    await typeText(title, 180);
    titleCaret.hidden = true;
    versionCaret.hidden = false;
    await Promise.all([delay(350), releaseReady]);
    await typeText(versionSlot, 140);
    await delay(500);
  } finally {
    titleCaret.hidden = true;
    versionCaret.hidden = true;
    title.querySelector('.type-text').textContent = '';
    versionSlot.querySelector('.type-text').textContent = '';
    brand.classList.remove('is-typing');
  }
}

typeBrand(loadLatestRelease());
