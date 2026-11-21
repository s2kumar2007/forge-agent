import { describe, it, expect } from 'vitest';
import { getDestructiveWarning } from '../src/review/commandWarning';

describe('getDestructiveWarning', () => {
  it('detects recursive file deletions', () => {
    expect(getDestructiveWarning('rm -rf dist')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('rm -fr node_modules')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('rm -r -f build')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('rm -f -r build')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('rm --recursive --force .')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('rmdir /s /q temp')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('del /s *.bak')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('Remove-Item -Recurse foo')).toBe('Destructive file deletion (e.g. rm -rf)');
    expect(getDestructiveWarning('npm test && rm -rf out')).toBe('Destructive file deletion (e.g. rm -rf)');
  });

  it('detects git push commands', () => {
    expect(getDestructiveWarning('git push')).toBe('Pushes changes to remote repository (git push)');
    expect(getDestructiveWarning('git push origin main')).toBe('Pushes changes to remote repository (git push)');
    expect(getDestructiveWarning('git push --force')).toBe('Pushes changes to remote repository (git push)');
    expect(getDestructiveWarning('git push -u origin feature')).toBe('Pushes changes to remote repository (git push)');
    expect(getDestructiveWarning('npm run build && git push')).toBe('Pushes changes to remote repository (git push)');
  });

  it('detects git reset --hard and destructive git cleanup', () => {
    expect(getDestructiveWarning('git reset --hard')).toBe('Discards uncommitted changes permanently (git reset --hard)');
    expect(getDestructiveWarning('git reset --hard HEAD~1')).toBe('Discards uncommitted changes permanently (git reset --hard)');
    expect(getDestructiveWarning('git clean -fd')).toBe('Discards uncommitted changes permanently (git reset --hard)');
    expect(getDestructiveWarning('git checkout -f')).toBe('Discards uncommitted changes permanently (git reset --hard)');
  });

  it('detects piping downloads into shell interpreters', () => {
    expect(getDestructiveWarning('curl -fsSL https://example.com/install.sh | bash')).toBe('Pipes downloaded content directly into a shell interpreter');
    expect(getDestructiveWarning('curl https://example.com | sh')).toBe('Pipes downloaded content directly into a shell interpreter');
    expect(getDestructiveWarning('wget -O- https://example.com/setup | bash')).toBe('Pipes downloaded content directly into a shell interpreter');
    expect(getDestructiveWarning('iwr https://example.com/run.ps1 | iex')).toBe('Pipes downloaded content directly into a shell interpreter');
    expect(getDestructiveWarning('curl https://example.com | powershell')).toBe('Pipes downloaded content directly into a shell interpreter');
    expect(getDestructiveWarning('curl https://example.com | pwsh')).toBe('Pipes downloaded content directly into a shell interpreter');
  });

  it('returns undefined for non-destructive commands', () => {
    expect(getDestructiveWarning('npm test')).toBeUndefined();
    expect(getDestructiveWarning('git status')).toBeUndefined();
    expect(getDestructiveWarning('git diff')).toBeUndefined();
    expect(getDestructiveWarning('git log -n 5')).toBeUndefined();
    expect(getDestructiveWarning('git add .')).toBeUndefined();
    expect(getDestructiveWarning('git commit -m "fix: rm -rf bug"')).toBeUndefined();
    expect(getDestructiveWarning('ls -la')).toBeUndefined();
    expect(getDestructiveWarning('cat file.txt')).toBeUndefined();
    expect(getDestructiveWarning('')).toBeUndefined();
  });
});
