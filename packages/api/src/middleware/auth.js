/**
 * Express middleware for JWT authentication and role-based authorisation.
 */
import { verifyAccessToken } from '../services/auth.js';

/**
 * Requires a valid JWT in the Authorization header.
 * Sets req.user = { sub, email, role, name }
 */
export function requireAuth(req, res, next) {
  // Support token via query string for iframe/download links opened in new tabs
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.slice(7);
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
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
