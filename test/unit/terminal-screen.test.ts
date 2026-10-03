import { describe, expect, it } from 'vitest';
import { classifyPromptLine, Screen } from '../../src/server/terminal/screen';
import { isFocusReport, isTerminalReport } from '../../src/shared/terminalProtocol';

describe('terminal rendered screen', () => {
  it('reads rendered text without ANSI codes and follows cursor rewrites', async () => {
    const s = new Screen(80, 24);
    try {
      s.write('\x1b[31mStatus ruim\x1b[0m\r\x1b[2KStatus ok\r\nPS C:\\test> ');
      await s.flush();
      expect(s.tail(5).join('\n')).toBe('Status ok\nPS C:\\test> ');
      expect(classifyPromptLine(s.cursorLine())).toBe('prompt');
    } finally { s.dispose(); }
  });

  it('responds to real cursor queries on the server, without browser input', async () => {
    const replies: string[] = [];
    const s = new Screen(80, 24, (data) => replies.push(data));
    try {
      s.write('hello\x1b[6n');
      await s.flush();
      expect(replies).toEqual(['\x1b[1;6R']);
      expect(isTerminalReport(replies[0])).toBe(true);
    } finally { s.dispose(); }
  });

  it.each(['\x1b[1;6R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'])('identifies emulator report %j', (data) => {
    expect(isTerminalReport(data)).toBe(true);
  });
  it.each(['hello', '\r', '\x03', '\x1b[A', '\x1b[200~hello\x1b[201~'])('preserves keyboard input %j', (data) => {
    expect(isTerminalReport(data)).toBe(false);
    expect(isFocusReport(data)).toBe(false);
  });

  it.each(['\x1b[I', '\x1b[O', '\x1b[O\x1b[I'])('identifies focus report %j as non-typing', (data) => {
    expect(isFocusReport(data)).toBe(true);
    expect(isTerminalReport(data)).toBe(false);
  });

  it('closing during a pending flush releases readers', async () => {
    const s = new Screen(80, 24);
    s.write('output');
    const pending = s.flush();
    s.dispose();
    await expect(pending).resolves.toBeUndefined();
    await expect(s.flush()).resolves.toBeUndefined();
  });

  it('joins wrapped lines and recognizes alternate screen', async () => {
    const s = new Screen(10, 4);
    try {
      s.write('ABCDEFGHIJKLMNO');
      await s.flush();
      expect(s.tail(4)).toEqual(['ABCDEFGHIJKLMNO']);
      s.write('\x1b[?1049hVIEW');
      await s.flush();
      expect(s.fullScreen).toBe(true);
      expect(s.viewport().join('\n')).toContain('VIEW');
    } finally { s.dispose(); }
  });

  it.each([
    ['PS C:\\test>', 'prompt'], ['user@host:~$', 'prompt'], ['[admin@MikroTik] >', 'prompt'],
    ['<HUAWEI>', 'prompt'], ['[~HUAWEI-GigabitEthernet0/0/1]', 'prompt'], ['Router(config)#', 'prompt'],
    ['Password:', 'password'], ['Username:', 'login'], ['Continue? [y/n]', 'confirm'],
    ['--More--', 'pager'], ['>>', null], ['...', null], ['PS C:\\test> half-command', null],
  ])('classifies %s as %s', (line, result) => expect(classifyPromptLine(line!)).toBe(result));
});
