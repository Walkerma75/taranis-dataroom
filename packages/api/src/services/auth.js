/**
 * Auth service — password hashing, JWT issuance, token validation.
 */
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-do-not-use-in-production';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_DAYS = 7;

// ---------------------------------------------------------------------------
// Password hashing (Argon2id per spec)
// ---------------------------------------------------------------------------

export async function hashPassword(plain) {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 65536,   // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain);
}

// ---------------------------------------------------------------------------
// JWT access tokens
// ---------------------------------------------------------------------------

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.display_name,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Opaque refresh tokens (stored hashed in DB)
// ---------------------------------------------------------------------------

export function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function storeRefreshToken(userId, token) {
  const hash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );
  return { hash, expiresAt };
}

export async function validateRefreshToken(token) {
  const hash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT rt.*, u.id AS uid, u.email, u.role, u.display_name, u.status
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1
       AND rt.revoked_at IS NULL
       AND rt.expires_at > NOW()`,
    [hash]
  );
  return rows[0] || null;
}

export async function revokeRefreshToken(token) {
  const hash = hashToken(token);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
    [hash]
  );
}

export async function revokeAllUserTokens(userId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

// ---------------------------------------------------------------------------
// Account lockout (5 failures, 15-minute lockout)
// ---------------------------------------------------------------------------

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

export async function recordFailedLogin(userId) {
  const { rows } = await pool.query(
    `UPDATE users
     SET failed_logins = failed_logins + 1,
         locked_until = CASE
           WHEN failed_logins + 1 >= $2 THEN NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
           ELSE locked_until
         END
     WHERE id = $1
     RETURNING failed_logins, locked_until`,
    [userId, MAX_FAILURES]
  );
  return rows[0];
}

export async function clearFailedLogins(userId) {
  await pool.query(
    `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`,
    [userId]
  );
}

export function isLocked(user) {
  return user.locked_until && new Date(user.locked_until) > new Date();
}

// ---------------------------------------------------------------------------
// Invite tokens
// ---------------------------------------------------------------------------

export function generateInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}
