/* Shared helpers used across marketing + app pages */
const VFX = {
  token() {
    return localStorage.getItem('vfx_token');
  },
  setToken(t) {
    if (t) localStorage.setItem('vfx_token', t);
  },
  clearToken() {
    localStorage.removeItem('vfx_token');
  },
  accountType() {
    const t = localStorage.getItem('vfx_account_type');
    return t === 'real' ? 'real' : 'demo';
  },
  setAccountType(t) {
    localStorage.setItem('vfx_account_type', t === 'real' ? 'real' : 'demo');
  },
  async api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = this.token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(path, Object.assign({ credentials: 'include' }, opts, { headers }));
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  async currentUser() {
    try {
      const { user } = await this.api('/api/auth/me');
      return user;
    } catch {
      return null;
    }
  },
  async logout() {
    try { await this.api('/api/auth/logout', { method: 'POST' }); } catch {}
    this.clearToken();
    window.location.href = '/login.html';
  },
  fmtMoney(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  /** Renders a Demo/Real toggle into the given element and wires a callback on change. */
  renderAccountSwitcher(el, onChange) {
    const current = this.accountType();
    el.title = 'Both Demo and Real are simulated — Real just starts at $0 with no bonus, like a live account before funding.';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;background:var(--bg-2,#161B27);border:1px solid var(--border,#252C3D);border-radius:8px;padding:3px;">
        <button type="button" data-acc="demo" style="padding:6px 12px;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;background:${current==='demo'?'#F0B90B':'transparent'};color:${current==='demo'?'#000':'#9AA3B8'};">DEMO</button>
        <button type="button" data-acc="real" style="padding:6px 12px;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;background:${current==='real'?'#0ECB81':'transparent'};color:${current==='real'?'#000':'#9AA3B8'};">REAL</button>
      </div>`;
    el.querySelectorAll('[data-acc]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setAccountType(btn.dataset.acc);
        this.renderAccountSwitcher(el, onChange);
        if (onChange) onChange(btn.dataset.acc);
      });
    });
  },
  requireAuthOrRedirect: async function () {
    const user = await this.currentUser();
    if (!user) window.location.href = '/login.html';
    return user;
  },
};

// Populate any nav account slot on marketing pages that has [data-vfx-account]
document.addEventListener('DOMContentLoaded', async () => {
  const slot = document.querySelector('[data-vfx-account]');
  if (!slot) return;
  const user = await VFX.currentUser();
  if (user) {
    const adminLink = user.role === 'admin' ? `<a href="/admin.html" class="btn btn-ghost">Admin</a>` : '';
    slot.innerHTML = `<a href="/dashboard.html" class="btn btn-ghost">Dashboard</a><a href="/wallet.html" class="btn btn-ghost">Wallet</a><a href="/wallet.html#ledger" class="btn btn-ghost">Transactions</a><a href="/instruments.html" class="btn btn-ghost">Instruments</a><a href="/security.html" class="btn btn-ghost">Security</a>${adminLink}<button class="btn btn-outline" id="vfxLogoutBtn">⏻ Log out</button>`;
    const btn = document.getElementById('vfxLogoutBtn');
    if (btn) btn.addEventListener('click', () => VFX.logout());
  } else {
    slot.innerHTML = `<a href="/login.html" class="btn btn-ghost">Log in</a><a href="/signup.html" class="btn btn-primary">Open account</a>`;
  }
});

// Mobile hamburger nav toggle — works on any page with a .nav-toggle button.
// Runs independently of login state so it fires even on pages without [data-vfx-account].
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('navToggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    links.classList.toggle('mobile-open');
  });
  // Close the menu after tapping a link, so it doesn't stay open on navigation
  links.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => links.classList.remove('mobile-open'));
  });
  // Close if the viewport is resized back to desktop width
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) links.classList.remove('mobile-open');
  });
});

// Renders a "← Back" icon button into el. Defaults to browser back if there's
// same-site history to go to, otherwise falls back to /dashboard.html.
VFX.renderBackButton = function (el, fallbackHref = '/dashboard.html') {
  el.innerHTML = `<button type="button" id="vfxBackBtn" title="Back" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:var(--bg-2,#161B27);border:1px solid var(--border,#252C3D);color:var(--text-0,#EAEDF4);cursor:pointer;font-size:16px;">←</button>`;
  document.getElementById('vfxBackBtn').addEventListener('click', () => {
    if (document.referrer && document.referrer.includes(location.host) && window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = fallbackHref;
    }
  });
};

