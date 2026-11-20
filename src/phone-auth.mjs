export function normalizePhone(value) {
  const input=String(value||'').trim().replace(/[\s().-]/g,'');
  if(/^0[35789]\d{8}$/.test(input))return `+84${input.slice(1)}`;
  if(/^84[35789]\d{8}$/.test(input))return `+${input}`;
  if(/^\+84[35789]\d{8}$/.test(input))return input;
  if(/^\+[1-9]\d{7,14}$/.test(input))return input;
  throw Error('Số điện thoại không hợp lệ. Hãy nhập số di động Việt Nam 10 chữ số, ví dụ 09xxxxxxxx.');
}

// Supabase's hosted phone provider requires an SMS vendor. The web keeps phone
// as the public login name and maps it to an internal, undeliverable email ID.
export function phoneLoginEmail(value) {
  return `${normalizePhone(value).slice(1)}@phone-login.ibeetool.com`;
}

export function passwordLoginIdentifier(value) {
  const input=String(value||'').trim();
  return input.includes('@')?{email:input.toLowerCase()}:{email:phoneLoginEmail(input)};
}
