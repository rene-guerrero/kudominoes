// Builds the Android debug APK with the local toolchain in ../android-toolchain (no global installs needed).
// Usage: npm run android:apk   (runs `npm run android:sync` first: web build + cap sync)
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const TOOLS = process.env.KUDO_ANDROID_TOOLCHAIN || resolve(root, '..', 'android-toolchain');
const env = {
  ...process.env,
  JAVA_HOME: join(TOOLS, 'jdk', 'jdk-21.0.13+9'),
  ANDROID_HOME: join(TOOLS, 'sdk'),
  ANDROID_SDK_ROOT: join(TOOLS, 'sdk'),
  GRADLE_USER_HOME: join(TOOLS, 'gradle-home'),
  ANDROID_USER_HOME: join(TOOLS, 'android-user-home'),
};
env.PATH = `${join(env.JAVA_HOME, 'bin')}${process.platform === 'win32' ? ';' : ':'}${env.PATH}`;
for (const k of ['JAVA_HOME', 'ANDROID_HOME']) if (!existsSync(env[k])) throw new Error(`${k} not found: ${env[k]}`);

// sdk.dir for Gradle (forward slashes are valid on Windows too)
writeFileSync(join(root, 'android', 'local.properties'), `sdk.dir=${env.ANDROID_HOME.split('\\').join('/')}\n`);

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!process.argv.includes('--no-sync')) run('npm', ['run', 'android:sync'], root);
// absolute path: Windows may not search the current directory (NoDefaultCurrentDirectoryInExePath)
const gradlew = join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(gradlew, ['assembleDebug', '--no-daemon'], join(root, 'android'));

const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (existsSync(apk)) console.log(`\nAPK: ${apk} (${(statSync(apk).size / 1048576).toFixed(1)} MB)`);
