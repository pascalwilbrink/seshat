/** Test-only admin credentials. Not usable anywhere real: the hash only matches TEST_ADMIN_PASSWORD. */
export const TEST_ADMIN_USERNAME = 'test-admin';
export const TEST_ADMIN_PASSWORD = 'test-only-password-123';
export const TEST_ADMIN_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$L3pDz9oVNfKXVaQVr0aHgw$p8AAfQn0un9sTyOyPElrRwl9TuFKIMZycUxNEyxEGqg';
export const TEST_SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';

export const TEST_ADMIN_ENV = {
  ADMIN_USERNAME: TEST_ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD_HASH,
  SESSION_SECRET: TEST_SESSION_SECRET,
};
