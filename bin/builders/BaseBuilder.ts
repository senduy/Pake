import path from 'path';
import fsExtra from 'fs-extra';
import chalk from 'chalk';
import prompts from 'prompts';

import { PakeAppOptions } from '@/types';
import { checkRustInstalled, installRust } from '@/helpers/rust';
import { mergeConfig } from '@/helpers/merge';
import tauriConfig from '@/helpers/tauriConfig';
import { npmDirectory } from '@/utils/dir';
import { getSpinner } from '@/utils/info';
import { shellExec } from '@/utils/shell';
import { isChinaDomain } from '@/utils/ip';
import { IS_MAC } from '@/utils/platform';
import logger from '@/options/logger';

export default abstract class BaseBuilder {
  protected options: PakeAppOptions;

  protected constructor(options: PakeAppOptions) {
    this.options = options;
  }

  private getBuildEnvironment() {
    return IS_MAC
      ? {
          CFLAGS: '-fno-modules',
          CXXFLAGS: '-fno-modules',
          MACOSX_DEPLOYMENT_TARGET: '14.0',
        }
      : undefined;
  }

  private getInstallTimeout(): number {
    return process.platform === 'win32' ? 600000 : 300000;
  }

  private getBuildTimeout(): number {
    return 900000; // 15 minutes for all builds
  }

  async prepare() {
    const tauriSrcPath = path.join(npmDirectory, 'src-tauri');
    const tauriTargetPath = path.join(tauriSrcPath, 'target');
    const tauriTargetPathExists = await fsExtra.pathExists(tauriTargetPath);

    if (!IS_MAC && !tauriTargetPathExists) {
      logger.warn('✼ The first use requires installing system dependencies.');
      logger.warn('✼ See more in https://tauri.app/start/prerequisites/.');
    }

    if (!checkRustInstalled()) {
      const res = await prompts({
        type: 'confirm',
        message: 'Rust not detected. Install now?',
        name: 'value',
      });

      if (res.value) {
        await installRust();
      } else {
        logger.error('✕ Rust required to package your webapp.');
        process.exit(0);
      }
    }

    const isChina = await isChinaDomain('www.npmjs.com');
    const spinner = getSpinner('Installing package...');
    const rustProjectDir = path.join(tauriSrcPath, '.cargo');
    const projectConf = path.join(rustProjectDir, 'config.toml');
    await fsExtra.ensureDir(rustProjectDir);

    // 统一使用npm，简单可靠
    const packageManager = 'npm';
    const registryOption = isChina
      ? ' --registry=https://registry.npmmirror.com'
      : '';
    const legacyPeerDeps = ' --legacy-peer-deps'; // 解决dependency conflicts

    const timeout = this.getInstallTimeout();

    const buildEnv = this.getBuildEnvironment();

    if (isChina) {
      logger.info('✺ Located in China, using npm/rsProxy CN mirror.');
      const projectCnConf = path.join(tauriSrcPath, 'rust_proxy.toml');
      await fsExtra.copy(projectCnConf, projectConf);
      await shellExec(
        `cd "${npmDirectory}" && ${packageManager} install${registryOption}${legacyPeerDeps} --silent`,
        timeout,
        buildEnv,
      );
    } else {
      await shellExec(
        `cd "${npmDirectory}" && ${packageManager} install${legacyPeerDeps} --silent`,
        timeout,
        buildEnv,
      );
    }
    spinner.succeed(chalk.green('Package installed!'));
    if (!tauriTargetPathExists) {
      logger.warn(
        '✼ The first packaging may be slow, please be patient and wait, it will be faster afterwards.',
      );
    }
  }

  async build(url: string) {
    await this.buildAndCopy(url, this.options.targets);
  }

  async start(url: string) {
    await mergeConfig(url, this.options, tauriConfig);
  }

  async buildAndCopy(url: string, target: string) {
    const { name } = this.options;
    await mergeConfig(url, this.options, tauriConfig);

    // Build app
    const buildSpinner = getSpinner('Building app...');
    // Let spinner run for a moment so user can see it, then stop before npm command
    await new Promise((resolve) => setTimeout(resolve, 500));
    buildSpinner.stop();
    // Show static message to keep the status visible
    logger.warn('✸ Building app...');

    const buildEnv = this.getBuildEnvironment();

    await shellExec(
      `cd "${npmDirectory}" && ${this.getBuildCommand()}`,
      this.getBuildTimeout(),
      buildEnv,
    );

    // Copy app
    const fileName = this.getFileName();
    const fileType = this.getFileType(target);
    const appPath = this.getBuildAppPath(npmDirectory, fileName, fileType);
    const distPath = path.resolve(`${name}.${fileType}`);
    await fsExtra.copy(appPath, distPath);
    await fsExtra.remove(appPath);
    logger.success('✔ Build success!');
    logger.success('✔ App installer located in', distPath);
  }

  protected getFileType(target: string): string {
    return target;
  }

  abstract getFileName(): string;

  protected getBuildCommand(): string {
    const baseCommand = this.options.debug
      ? 'npm run build:debug'
      : 'npm run build';

    // Use temporary config directory to avoid modifying source files
    const configPath = path.join(
      npmDirectory,
      'src-tauri',
      '.pake',
      'tauri.conf.json',
    );
    let fullCommand = `${baseCommand} -- -c "${configPath}"`;

    // For macOS, use app bundles by default unless DMG is explicitly requested
    if (IS_MAC && this.options.targets === 'app') {
      fullCommand += ' --bundles app';
    }

    // Add features
    const features = ['cli-build'];

    // Add macos-proxy feature for modern macOS (Darwin 23+ = macOS 14+)
    if (IS_MAC) {
      const macOSVersion = this.getMacOSMajorVersion();
      if (macOSVersion >= 23) {
        features.push('macos-proxy');
      }
    }

    if (features.length > 0) {
      fullCommand += ` --features ${features.join(',')}`;
    }

    return fullCommand;
  }

  protected getMacOSMajorVersion(): number {
    try {
      const os = require('os');
      const release = os.release();
      const majorVersion = parseInt(release.split('.')[0], 10);
      return majorVersion;
    } catch (error) {
      return 0; // Disable proxy feature if version detection fails
    }
  }

  protected getBasePath(): string {
    const basePath = this.options.debug ? 'debug' : 'release';
    return `src-tauri/target/${basePath}/bundle/`;
  }

  protected getBuildAppPath(
    npmDirectory: string,
    fileName: string,
    fileType: string,
  ): string {
    // For app bundles on macOS, the directory is 'macos', not 'app'
    const bundleDir =
      fileType.toLowerCase() === 'app' ? 'macos' : fileType.toLowerCase();
    return path.join(
      npmDirectory,
      this.getBasePath(),
      bundleDir,
      `${fileName}.${fileType}`,
    );
  }
}
