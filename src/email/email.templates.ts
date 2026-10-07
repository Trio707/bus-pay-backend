function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function masterWakalaCredentialEmail(input: {
  fullName: string;
  email: string;
  temporaryPassword: string;
  loginUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = 'Your BusPay Master Wakala Account';
  const text = [
    `Hello ${input.fullName},`,
    '',
    'Your BusPay Master Wakala account has been created by the BusPay Administrator.',
    '',
    'Login email:',
    input.email,
    '',
    'Temporary password:',
    input.temporaryPassword,
    '',
    'Login:',
    input.loginUrl,
    '',
    'For your security, you will be required to change your temporary password when you first sign in.',
    '',
    'Please do not share your login credentials with anyone.',
    '',
    'Regards,',
    'BusPay Administration',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<body style="font-family: Georgia, serif; color: #0f172a; line-height: 1.5;">
  <p style="font-size: 20px; letter-spacing: 0.04em; margin-bottom: 8px;"><strong>BusPay</strong></p>
  <p>Hello ${escapeHtml(input.fullName)},</p>
  <p>Your BusPay Master Wakala account has been created by the BusPay Administrator.</p>
  <p><strong>Login email:</strong><br>${escapeHtml(input.email)}</p>
  <p><strong>Temporary password:</strong><br>${escapeHtml(input.temporaryPassword)}</p>
  <p><strong>Login:</strong><br><a href="${escapeHtml(input.loginUrl)}">${escapeHtml(input.loginUrl)}</a></p>
  <p>For your security, you will be required to change your temporary password when you first sign in.</p>
  <p>Please do not share your login credentials with anyone.</p>
  <p>Regards,<br>BusPay Administration</p>
</body>
</html>`;

  return { subject, text, html };
}

export function emailConfigurationTest(): { subject: string; text: string; html: string } {
  const subject = 'BusPay email configuration test';
  const text = [
    'This is a BusPay email configuration test.',
    'No account credentials are included.',
    '',
    'Regards,',
    'BusPay Administration',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html>
<body style="font-family: Georgia, serif; color: #0f172a;">
  <p style="font-size: 20px;"><strong>BusPay</strong></p>
  <p>This is a BusPay email configuration test.</p>
  <p>No account credentials are included.</p>
  <p>Regards,<br>BusPay Administration</p>
</body>
</html>`;
  return { subject, text, html };
}
