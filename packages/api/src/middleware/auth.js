/**
 * Express middleware for JWT authentication and role-based authorisation.
 *
 * The company DD portal added a hard boundary in both directions:
 *
 *   fund side   -> `rejectCompanyRole` on every fund, document, grant, notice,
 *                  user and audit router. Belt and braces: role 'company' users
 *                  also hold no rows in `grants`, so even without this they
 *                  would see nothing. The explicit rejection exists so a future
 *                  grant written by mistake cannot open the door.
 *
 *   company side -> `requireCompany` on every /api/company/* route. Scope comes
 *                  from the JWT `companyId` claim and never from a path, query
 *                  or body parameter, so there is no id for a company user to
 *                  guess. Membership and company status are re-read from the
 *                  database on every request, so a deactivated user or a
 *                  suspended company loses access at once rather than when
 *                  their 15-minute access token expires.
 */
import { verifyAccessToken } from '../services/auth.js';
import { loadCompanyMembership, taranisAccessLevel, canWriteAtLevel } from '../services/companies.js';

function readBearer(req) {
  // Support token via query string for iframe/download links opened in new tabs
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Requires a valid JWT in the Authorization header.
 * Sets req.user = { sub, email, role, name, companyId?, companyRole? }
 *
 * An `mfaPending` token is rejected here. That is the whole mechanism behind
 * mandatory MFA for the company role: a company user who has not enrolled in
 * TOTP holds a token that reaches the enrolment endpoints and nothing else.
 * Because the rejection is the default, no existing call site had to change and
 * no future route can forget it. The enrolment endpoints opt in explicitly with
 * `requireAuthForMfaEnrolment`.
 */
export function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (req.user.mfaPending) {
    return res.status(403).json({
      error: 'Two-factor authentication must be set up before you can continue.',
      mfaEnrolmentRequired: true,
    });
  }

  next();
}

/**
 * As `requireAuth`, but accepts the crippled `mfaPending` token. Mounted ONLY
 * on the MFA setup and verify endpoints.
 */
export function requireAuthForMfaEnrolment(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
  next();
}

/**
 * Requires the authenticated user to have one of the specified roles.
 * Must be used AFTER requireAuth.
 *
 * Usage: requireRole('admin')  or  requireRole('admin', 'investor')
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Fund-side guard
// ---------------------------------------------------------------------------

/**
 * Explicit early rejection of role 'company' on every fund-side router.
 *
 * Company users are not part of the fund permission matrix at all, so this is
 * not the only thing standing between them and fund material. It is the one
 * that does not depend on any data being correct.
 */
export function rejectCompanyRole(req, res, next) {
  if (req.user?.role === 'company') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Company-side guards
// ---------------------------------------------------------------------------

/**
 * Gate every /api/company/* route.
 *
 * Rejects, in order:
 *   - anything that is not role 'company'
 *   - a token with no companyId claim
 *   - a membership that no longer exists or has been deactivated
 *   - a membership whose companyId no longer matches the claim, which would
 *     mean the token outlived a move between companies
 *   - a company that is anything other than 'active': 'pending', 'suspended'
 *     and 'offboarded' are all blocked here, at the middleware, so no handler
 *     ever has to remember to check
 *
 * On success sets `req.company` from the DATABASE row, keyed by the claim.
 */
export function requireCompany() {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role !== 'company') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (!req.user.companyId) {
      return res.status(403).json({ error: 'No company is associated with this account' });
    }

    try {
      const membership = await loadCompanyMembership(req.user.sub);

      if (!membership) {
        return res.status(403).json({ error: 'Your access to this workspace has been withdrawn' });
      }
      if (membership.company_id !== req.user.companyId) {
        // The token names a company the user is no longer a member of.
        return res.status(403).json({ error: 'Your access to this workspace has been withdrawn' });
      }
      if (!membership.approved_by) {
        return res.status(403).json({ error: 'This account is awaiting approval by Taranis' });
      }
      if (membership.company_status !== 'active') {
        return res.status(403).json({
          error: membership.company_status === 'pending'
            ? 'This workspace is not yet open'
            : 'This workspace is not currently available',
        });
      }

      req.company = {
        id: membership.company_id,
        legalName: membership.legal_name,
        fundId: membership.fund_id,
        status: membership.company_status,
      };
      req.companyMembership = {
        id: membership.membership_id,
        role: membership.company_role,
        isPrimary: membership.is_primary,
      };
      next();
    } catch (err) {
      console.error('[auth] Company scope resolution failed:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Requires one of the given company-side roles on the membership record.
 * Must be used AFTER `requireCompany()`.
 *
 * Usage: requireCompanyRole('company_admin')
 */
export function requireCompanyRole(...roles) {
  return (req, res, next) => {
    if (!req.companyMembership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (!roles.includes(req.companyMembership.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Taranis-side access to a single company
// ---------------------------------------------------------------------------

/**
 * Gate an admin-side company route. Admins pass for any company; a non-admin
 * Taranis user needs a `company_reviewers` row for that specific company, which
 * is how a specialist consultant gets one company and nothing else.
 *
 * `write: true` additionally refuses the 'readonly' assignment level.
 *
 * Sets `req.accessLevel` to 'admin' | 'reviewer' | 'readonly'.
 */
export function requireCompanyAccess({ write = false, param = 'id' } = {}) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role === 'company') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const companyId = req.params[param];
    if (!companyId) {
      return res.status(400).json({ error: 'Company id required' });
    }

    try {
      const level = await taranisAccessLevel({
        userId: req.user.sub,
        role: req.user.role,
        companyId,
      });

      // Same response for "no such company" and "not yours", so the endpoint
      // cannot be used to discover which company ids exist.
      if (!level) return res.status(404).json({ error: 'Company not found' });
      if (write && !canWriteAtLevel(level)) {
        return res.status(403).json({ error: 'Your access to this company is read-only' });
      }

      req.accessLevel = level;
      next();
    } catch (err) {
      console.error('[auth] Company access resolution failed:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
