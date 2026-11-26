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

async function typeText(slot) {
  const value = slot.querySelector('.type-value').textContent;
  const ink = slot.querySelector('.type-ink');
  ink.classList.add('with-caret');
  for (const letter of value) {
    ink.textContent += letter;
    await delay(65);
  }
  return ink;
}

async function typeBrand(releaseReady) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const brand = document.querySelector('.brand');
  brand.classList.add('is-typing');
  const title = await typeText(brand.querySelector('h1'));
  await releaseReady;
  title.classList.remove('with-caret');
  const versionInk = await typeText(brand.querySelector('.version'));
  versionInk.classList.remove('with-caret');
  title.textContent = '';
  versionInk.textContent = '';
  brand.classList.remove('is-typing');
}

async function readGithubResource(path) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://api.github.com/repos/' + repository + path, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (response.ok) return await response.json();
  } catch {
    // Leave the local repository information in place.
  } finally {
    window.clearTimeout(timeout);
  }
  return null;
}

async function loadRepositoryCounts() {
  const data = await readGithubResource('');
  const formatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  for (const [id, count] of [['repo-stars', data?.stargazers_count], ['repo-forks', data?.forks_count]]) {
    if (Number.isSafeInteger(count) && count >= 0) {
      document.getElementById(id).textContent = formatter.format(count);
    }
  }
}

async function loadContributors() {
  const contributors = await readGithubResource('/contributors?per_page=3');
  if (!Array.isArray(contributors)) return;

  const list = document.querySelector('#repo-contributors');
  const fallback = list.querySelector('.repo-contributor');
  const links = contributors.slice(0, 3)
    .filter((person) => typeof person?.login === 'string' && /^[a-z0-9-]+(?:\[bot\])?$/i.test(person.login))
    .map((person) => {
      const link = fallback.cloneNode(true);
      link.href = 'https://github.com/' + encodeURIComponent(person.login);
      link.querySelector('span').textContent = person.login;
      const avatar = link.querySelector('img');
      if (typeof person.avatar_url === 'string' && person.avatar_url.startsWith('https://avatars.githubusercontent.com/')) {
        avatar.addEventListener('error', () => {
          if (link.href === fallback.href) avatar.src = fallback.querySelector('img').src;
          else avatar.remove();
        }, { once: true });
        avatar.src = person.avatar_url;
      } else if (link.href !== fallback.href) {
        avatar.remove();
      }
      return link;
    });

  if (links.length) list.replaceChildren(...links);
}

typeBrand(loadLatestRelease());
loadRepositoryCounts();
loadContributors();
