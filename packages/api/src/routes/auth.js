/**
 * Auth routes — login, refresh, logout, invite accept, MFA setup/verify.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { pool } from '../db.js';
import {
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  recordFailedLogin,
  clearFailedLogins,
  isLocked,
  hashPassword,
  generateInviteToken,
  hashToken,
} from '../services/auth.js';
import { logAudit } from '../services/audit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password, totpCode } = req.body;
  const ip = req.ip;
  const ua = req.headers['user-agent'];

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Find user
    const { rows: [user] } = await pool.query(
      `SELECT u.*, m.totp_secret, m.totp_verified,
              COALESCE(u.capabilities, '{}') AS capabilities
       FROM users u
       LEFT JOIN user_mfa m ON m.user_id = u.id
       WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.status === 'disabled') {
      return res.status(403).json({ error: 'Account disabled' });
    }

    if (isLocked(user)) {
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    // Verify password
    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      await recordFailedLogin(user.id);
      await logAudit({ action: 'login.failed', userId: user.id, detail: { reason: 'bad_password' }, ip, userAgent: ua });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check MFA if enabled
    if (user.totp_verified) {
      if (!totpCode) {
        return res.status(200).json({ mfaRequired: true, message: 'TOTP code required' });
      }
      const validTotp = authenticator.check(totpCode, user.totp_secret);
      if (!validTotp) {
        await recordFailedLogin(user.id);
        await logAudit({ action: 'login.failed', userId: user.id, detail: { reason: 'bad_totp' }, ip, userAgent: ua });
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Success — issue tokens
    await clearFailedLogins(user.id);

    const accessToken = signAccessToken(user);
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(user.id, refreshToken);

    await logAudit({ action: 'login.success', userId: user.id, ip, userAgent: ua });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        mfaEnabled: !!user.totp_verified,
        capabilities: user.capabilities || {},
      },
    });
  } catch (err) {
    console.error('[auth] Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const record = await validateRefreshToken(refreshToken);
    if (!record) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    if (record.status !== 'active') return res.status(403).json({ error: 'Account not active' });

    // Rotate: revoke old, issue new
    await revokeRefreshToken(refreshToken);
    const newRefresh = generateRefreshToken();
    await storeRefreshToken(record.uid, newRefresh);

    const accessToken = signAccessToken({
      id: record.uid,
      email: record.email,
      role: record.role,
      display_name: record.display_name,
    });

    res.json({ accessToken, refreshToken: newRefresh });
  } catch (err) {
    console.error('[auth] Refresh error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
  await logAudit({ action: 'logout', userId: req.user.sub, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ message: 'Logged out' });
});

// ---------------------------------------------------------------------------
// GET /auth/me — return current user profile
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at,
              COALESCE(m.totp_verified, false) AS mfa_enabled,
              COALESCE(u.capabilities, '{}') AS capabilities
       FROM users u
       LEFT JOIN user_mfa m ON m.user_id = u.id
       WHERE u.id = $1`,
      [req.user.sub]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfa_enabled,
      capabilities: user.capabilities || {},
      createdAt: user.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/mfa/setup — generate TOTP secret + QR code
// ---------------------------------------------------------------------------
router.post('/mfa/setup', requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.email, 'Taranis Data Room', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    // Upsert MFA record (not yet verified)
    await pool.query(
      `INSERT INTO user_mfa (user_id, totp_secret, totp_verified)
       VALUES ($1, $2, false)
       ON CONFLICT (user_id) DO UPDATE SET totp_secret = $2, totp_verified = false`,
      [req.user.sub, secret]
    );

    res.json({ secret, qrCode: qrDataUrl });
  } catch (err) {
    console.error('[auth] MFA setup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/mfa/verify — confirm TOTP code to enable MFA
// ---------------------------------------------------------------------------
router.post('/mfa/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'TOTP code required' });

  try {
    const { rows: [mfa] } = await pool.query(
      `SELECT * FROM user_mfa WHERE user_id = $1`,
      [req.user.sub]
    );
    if (!mfa || !mfa.totp_secret) {
      return res.status(400).json({ error: 'MFA not set up. Call /auth/mfa/setup first.' });
    }

    const valid = authenticator.check(code, mfa.totp_secret);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code. Please try again.' });
    }

    // Generate recovery codes
    const recoveryCodes = Array.from({ length: 8 }, () =>
      crypto.randomBytes(4).toString('hex')
    );

    await pool.query(
      `UPDATE user_mfa
       SET totp_verified = true, enabled_at = NOW(), recovery_codes = $2
       WHERE user_id = $1`,
      [req.user.sub, recoveryCodes]
    );

    await logAudit({ action: 'mfa.enabled', userId: req.user.sub, ip: req.ip });

    res.json({ message: 'MFA enabled', recoveryCodes });
  } catch (err) {
    console.error('[auth] MFA verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/invite — admin sends an invite (creates user + invite token)
// ---------------------------------------------------------------------------
router.post('/invite', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, displayName, role } = req.body;
  if (!email || !displayName) {
    return res.status(400).json({ error: 'Email and display name are required' });
  }

  const validRoles = ['investor', 'advisor', 'viewer', 'admin'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    // Create or reactivate user
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, display_name, role, status)
       VALUES ($1, $2, $3, 'invited')
       ON CONFLICT (email) DO UPDATE SET display_name = $2, role = $3, status = 'invited'
       RETURNING id`,
      [email.toLowerCase().trim(), displayName, role || 'viewer']
    );

    // Generate invite token
    const token = generateInviteToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 86400 * 1000); // 7 days

    await pool.query(
      `INSERT INTO invites (email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [email.toLowerCase().trim(), role || 'viewer', tokenHash, req.user.sub, expiresAt]
    );

    await logAudit({
      action: 'invite.sent',
      userId: req.user.sub,
      resource: 'user',
      resourceId: user.id,
      detail: { invitedEmail: email, role: role || 'viewer' },
      ip: req.ip,
    });

    // In production this sends an email. For now, return the token for testing.
    res.status(201).json({
      message: 'Invite created',
      userId: user.id,
      inviteUrl: `/invite/accept?token=${token}`,
      expiresAt,
    });
  } catch (err) {
    console.error('[auth] Invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/invite/accept — set password from invite token
// ---------------------------------------------------------------------------
router.post('/invite/accept', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  if (password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  try {
    const tokenHash = hashToken(token);
    const { rows: [invite] } = await pool.query(
      `SELECT * FROM invites
       WHERE token_hash = $1
         AND accepted_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash]
    );

    if (!invite) {
      return res.status(400).json({ error: 'Invalid or expired invite token' });
    }

    const passwordHash = await hashPassword(password);

    // Set default capabilities based on role
    const roleCapabilities = {
      admin: { canManageUsers: true, canManageFunds: true, canUploadDocuments: true, canViewAudit: true, canDownloadDocuments: true, canViewDocuments: true },
      investor: { canManageUsers: false, canManageFunds: false, canUploadDocuments: false, canViewAudit: false, canDownloadDocuments: true, canViewDocuments: true },
      advisor: { canManageUsers: false, canManageFunds: false, canUploadDocuments: true, canViewAudit: false, canDownloadDocuments: true, canViewDocuments: true },
      viewer: { canManageUsers: false, canManageFunds: false, canUploadDocuments: false, canViewAudit: false, canDownloadDocuments: false, canViewDocuments: true },
    };
    const caps = roleCapabilities[invite.role] || roleCapabilities.viewer;

    await pool.query(
      `UPDATE users SET password_hash = $1, status = 'active', capabilities = $3, updated_at = NOW()
       WHERE email = $2`,
      [passwordHash, invite.email, JSON.stringify(caps)]
    );

    await pool.query(
      `UPDATE invites SET accepted_at = NOW() WHERE id = $1`,
      [invite.id]
    );

    await logAudit({
      action: 'invite.accepted',
      resource: 'user',
      detail: { email: invite.email },
      ip: req.ip,
    });

    res.json({ message: 'Account activated. You can now log in.' });
  } catch (err) {
    console.error('[auth] Invite accept error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password — admin generates a password reset link for a user
// ---------------------------------------------------------------------------
router.post('/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const { rows: [user] } = await pool.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = generateInviteToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt]
    );

    await logAudit({
      action: 'password.reset_initiated',
      userId: req.user.sub,
      resource: 'user',
      resourceId: userId,
      detail: { targetEmail: user.email },
      ip: req.ip,
    });

    res.json({
      message: 'Password reset link generated',
      resetUrl: `/reset-password?token=${token}`,
      expiresAt,
    });
  } catch (err) {
    console.error('[auth] Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password/confirm — user sets new password via reset token
// ---------------------------------------------------------------------------
router.post('/reset-password/confirm', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });

  try {
    const tokenHash = hashToken(token);
    const { rows: [reset] } = await pool.query(
      `SELECT * FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const passwordHash = await hashPassword(password);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, reset.user_id]
    );

    // Mark token as used
    await pool.query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [reset.id]);

    // Revoke all refresh tokens
    await revokeAllUserTokens(reset.user_id);

    await logAudit({
      action: 'password.reset_completed',
      resource: 'user',
      resourceId: reset.user_id,
      ip: req.ip,
    });

    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) {
    console.error('[auth] Reset confirm error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/change-password
// ---------------------------------------------------------------------------
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  try {
    const { rows: [user] } = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user.sub]
    );

    const valid = await verifyPassword(user.password_hash, currentPassword);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await hashPassword(newPassword);
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, req.user.sub]);

    // Revoke all refresh tokens (force re-login everywhere)
    await revokeAllUserTokens(req.user.sub);

    await logAudit({ action: 'password.changed', userId: req.user.sub, ip: req.ip });

    res.json({ message: 'Password changed. Please log in again.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
