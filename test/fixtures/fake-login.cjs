// CLI sintética para testar login na interface; nunca usa credenciais reais.
if (process.argv.includes('models')) {
  console.log('gemini-4-argon-medium     Gemini 4 Argon (Medium)');
  console.log('claude-opus-5-5-low       Claude Opus 5.5 (Low)');
  process.exit(0);
}
if (process.argv.includes('-p')) {
  console.log(JSON.stringify({ type: 'init', session_id: 'fake-session' }));
  process.stdin.resume();
  return;
}
const isClaude = process.argv.includes('auth');
process.stdin.setRawMode?.(true);
process.stdin.resume();
let stage = 0;
let input = '';
function showUrl() {
  stage = 1;
  process.stdout.write('\x1b[2J\x1b[HOpen the URL below in your browser:\r\n' + (isClaude
    ? 'https://claude.ai/oauth/authorize?state=fake&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback'
    : 'https://accounts.google.com/o/oauth2/auth?state=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback') + '\r\nAfter authenticating, paste the authorization code:\r\n');
}
if (isClaude) showUrl();
else process.stdout.write('Select login method:\r\n > 1. Google OAuth\r\n   2. Use a Google Cloud project\r\n');
process.stdin.on('data', (chunk) => {
  const data = chunk.toString();
  if (stage === 0 && data.includes('\r')) return showUrl();
  if (stage === 1) {
    input += data;
    if (input.includes('\r')) {
      stage = 2;
      if (input.trim() === 'fake-code') {
        process.stdout.write('\x1b[2J\x1b[HLogin successful\r\n');
        if (isClaude) setTimeout(() => process.exit(0), 600);
      } else process.stdout.write('\r\nInvalid code\r\n');
    }
  }
});
