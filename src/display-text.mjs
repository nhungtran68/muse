// Only for system notices and error messages; never apply to customer content.
export function displayMessage(value) {
  return String(value ?? '')
    .replace(/\bmuse_[a-z_]+\b/gi, 'lỗi hệ thống')
    .replace(/muse(?:\.ai)?(?:\s+studio)?/gi, 'hệ thống');
}
