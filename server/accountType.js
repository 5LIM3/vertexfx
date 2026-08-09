const VALID_ACCOUNT_TYPES = ['demo', 'real'];

/**
 * Reads which account (demo or real) a request applies to.
 * Checked in order: query string (?account=), JSON body (accountType), then
 * defaults to 'demo' — the safer default if a client forgets to specify one.
 */
function getAccountType(req) {
  const raw = req.query?.account || req.body?.accountType || 'demo';
  return VALID_ACCOUNT_TYPES.includes(raw) ? raw : 'demo';
}

module.exports = { getAccountType, VALID_ACCOUNT_TYPES };
