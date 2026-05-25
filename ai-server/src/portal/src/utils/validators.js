/**
 * Validators
 */

export function validateEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

export function validatePassword(password) {
  return password && password.length >= 8;
}
