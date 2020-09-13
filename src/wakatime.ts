import * as vscode from 'vscode';
import * as child_process from 'child_process';

import { Dependencies } from './dependencies';
import { COMMAND_DASHBOARD, LogLevel } from './constants';
import { Options } from './options';
import { Logger } from './logger';
import { Libs } from './libs';

export class WakaTime {
  private appNames = {
    'SQL Operations Studio': 'sqlops',
    'Visual Studio Code': 'vscode',
  };
  private agentName: string;
  private extension;
  private statusBar: vscode.StatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private extensionPath: string;
  private dependencies: Dependencies;
  private options: Options;
  private logger: Logger;
  private getCodingActivityTimeout: NodeJS.Timer;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showCodingActivity: boolean;
  private standalone: boolean;

  constructor(extensionPath: string, logger: Logger, options: Options) {
    this.extensionPath = extensionPath;
    this.logger = logger;
    this.options = options;
  }

  public initialize(standalone: boolean): void {
    this.standalone = standalone;
    this.dependencies = new Dependencies(
      this.options,
      this.extensionPath,
      this.logger,
      this.standalone,
    );
    this.statusBar.command = COMMAND_DASHBOARD;

    let extension = vscode.extensions.getExtension('WakaTime.vscode-wakatime');
    this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
    this.logger.debug(`Initializing WakaTime v${this.extension.version}`);
    this.agentName = this.appNames[vscode.env.appName] || 'vscode';
    this.statusBar.text = '$(clock) WakaTime Initializing...';
    this.statusBar.show();
    if (this.standalone) this.logger.debug('Using standalone wakatime-cli.');
    this.options.getSetting('settings', 'disabled', (_e, disabled) => {
      if (disabled !== "true") this.checkApiKey();
    });
    
    this.dependencies.checkAndInstall(() => {
      this.logger.debug('WakaTime: Initialized');
      this.statusBar.text = '$(clock)';
      this.statusBar.tooltip = 'WakaTime: Initialized';
      this.options.getSetting('settings', 'status_bar_enabled', (_err, val) => {
        if (val == 'false') {
          this.showStatusBar = false;
          this.statusBar.hide();
        } else {
          this.showStatusBar = true;
          this.statusBar.show();
        }
      });
      this.options.getSetting('settings', 'status_bar_coding_activity', (_err, val) => {
        if (val == 'false') {
          this.showCodingActivity = false;
        } else {
          this.showCodingActivity = true;
          this.getCodingActivity();
        }
      });
    });

    this.setupEventListeners();
  }

  public promptToDisable(): void {
    this.options.getSetting('settings', 'disabled', (_err, currentVal) => {
      if (!currentVal || currentVal !== 'true') currentVal = 'false';
      let items: string[] = ['disable', 'enable'];
      const helperText =  currentVal === 'true' ? "disabled" : "enabled";
      let promptOptions = {
        placeHolder: `disable or enable (extension is currently "${helperText}")`,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then(newVal => {
        if (newVal === 'disable') {
          this.options.setSetting('settings', 'disabled', 'true');
          this.options.getSetting('settings', 'status_bar_enabled', (_err, currentValue) => {
            if (!currentValue || currentValue === 'true')  this.updateStatusBar('false');
          });
          
        };
        if (newVal === 'enable') {
          this.options.setSetting('settings', 'disabled', 'false');
          this.options.getSetting('settings', 'status_bar_enabled', (_err, currentValue) => {
            if (currentValue === 'false') this.updateStatusBar('true');
          });
        }
      });
    });
  }

  public promptForApiKey(): void {
    this.options.getSetting('settings', 'api_key', (_err, defaultVal) => {
      if (Libs.validateKey(defaultVal) != '') defaultVal = '';
      let promptOptions = {
        prompt: 'WakaTime Api Key',
        placeHolder: 'Enter your api key from https://wakatime.com/settings',
        value: defaultVal,
        ignoreFocusOut: true,
        validateInput: Libs.validateKey.bind(this),
      };
      vscode.window.showInputBox(promptOptions).then(val => {
        if (val != undefined) {
          let validation = Libs.validateKey(val);
          if (validation === '') this.options.setSetting('settings', 'api_key', val);
          else vscode.window.setStatusBarMessage(validation);
        } else vscode.window.setStatusBarMessage('WakaTime api key not provided');
      });
    });
  }

  public promptForProxy(): void {
    this.options.getSetting('settings', 'proxy', (_err, defaultVal) => {
      if (!defaultVal) defaultVal = '';
      let promptOptions = {
        prompt: 'WakaTime Proxy',
        placeHolder: `Proxy format is https://user:pass@host:port (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
        validateInput: Libs.validateProxy.bind(this),
      };
      vscode.window.showInputBox(promptOptions).then(val => {
        if (val || val === '') this.options.setSetting('settings', 'proxy', val);
      });
    });
  }

  public promptForDebug(): void {
    this.options.getSetting('settings', 'debug', (_err, defaultVal) => {
      if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then(newVal => {
        if (newVal == null) return;
        this.options.setSetting('settings', 'debug', newVal);
        if (newVal === 'true') {
          this.logger.setLevel(LogLevel.DEBUG);
          this.logger.debug('Debug enabled');
        } else {
          this.logger.setLevel(LogLevel.INFO);
        }
      });
    });
  }

  public promptStatusBarIcon(): void {
    this.options.getSetting('settings', 'status_bar_enabled', (_err, defaultVal) => {
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then(newVal => this.updateStatusBar(newVal));
    });
  }

  private updateStatusBar = (newVal) => {
    if (newVal == null) return;
    this.options.setSetting('settings', 'status_bar_enabled', newVal);
    if (newVal === 'true') {
      this.showStatusBar = true;
      this.statusBar.show();
      this.logger.debug('Status bar icon enabled');
    } else {
      this.showStatusBar = false;
      this.statusBar.hide();
      this.logger.debug('Status bar icon disabled');
    }
  }

  public promptStatusBarCodingActivity(): void {
    this.options.getSetting('settings', 'status_bar_coding_activity', (_err, defaultVal) => {
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then(newVal => {
        if (newVal == null) return;
        this.options.setSetting('settings', 'status_bar_coding_activity', newVal);
        if (newVal === 'true') {
          this.logger.debug('Coding activity in status bar has been enabled');
          this.showCodingActivity = true;
          this.getCodingActivity(true);
        } else {
          this.logger.debug('Coding activity in status bar has been disabled');
          this.showCodingActivity = false;
          if (this.statusBar.text.indexOf('Error') == -1) {
            this.statusBar.text = '$(clock)';
          }
        }
      });
    });
  }

  public openDashboardWebsite(): void {
    let url = 'https://wakatime.com/';
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  public openConfigFile(): void {
    let path = this.options.getConfigFile();
    if (path) {
      let uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  public openLogFile(): void {
    let path = this.options.getLogFile();
    if (path) {
      let uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  public dispose() {
    this.statusBar.dispose();
    this.disposable.dispose();
    clearTimeout(this.getCodingActivityTimeout);
  }

  private checkApiKey(): void {
    this.hasApiKey(hasApiKey => {
      if (!hasApiKey) this.promptForApiKey();
    });
  }

  private hasApiKey(callback: (arg0: boolean) => void): void {
    this.options
      .getApiKeyAsync()
      .then(apiKey => callback(Libs.validateKey(apiKey) === ''))
      .catch(err => {
        this.logger.error(`Error reading api key: ${err}`);
        callback(false);
      });
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    let subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChange, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChange, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    // create a combined disposable from both event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onChange(): void {
    this.onEvent(false);
  }

  private onSave(): void {
    this.onEvent(true);
  }

  private onEvent(isWrite: boolean): void {
    this.options.getSetting('settings', 'disabled', (_e, disabled) => {
      if (disabled !== "true"){
        let editor = vscode.window.activeTextEditor;
        if (editor) {
          let doc = editor.document;
          if (doc) {
            let file: string = doc.fileName;
            if (file) {
              let time: number = Date.now();
              if (isWrite || this.enoughTimePassed(time) || this.lastFile !== file) {
                this.sendHeartbeat(file, isWrite);
                this.lastFile = file;
                this.lastHeartbeat = time;
              }
            }
          }
        }
      }
    });
  }

  private sendHeartbeat(file: string, isWrite: boolean): void {
    this.hasApiKey(hasApiKey => {
      if (hasApiKey) {
        if (this.standalone === undefined) return;
        if (this.standalone) {
          this._sendHeartbeat(file, isWrite);
        } else {
          this.dependencies.getPythonLocation(pythonBinary => {
            if (pythonBinary) {
              this._sendHeartbeat(file, isWrite, pythonBinary);
            }
          });
        }
      } else {
        this.promptForApiKey();
      }
    });
  }

  private _sendHeartbeat(file: string, isWrite: boolean, pythonBinary?: string): void {
    if (this.standalone && !this.dependencies.isStandaloneCliInstalled()) return;
    let cli = this.standalone
      ? this.dependencies.getStandaloneCliLocation()
      : this.dependencies.getCliLocation();
    let user_agent =
      this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version;
    let args = ['--file', Libs.quote(file), '--plugin', Libs.quote(user_agent)];
    if (!this.standalone) args.unshift(cli);
    let project = this.getProjectName(file);
    if (project) args.push('--alternate-project', Libs.quote(project));
    if (isWrite) args.push('--write');
    if (Dependencies.isWindows() || this.options.isPortable()) {
      args.push(
        '--config',
        Libs.quote(this.options.getConfigFile()),
        '--log-file',
        Libs.quote(this.options.getLogFile()),
      );
    }

    const binary = this.standalone || !pythonBinary ? cli : pythonBinary;
    this.logger.debug(`Sending heartbeat: ${this.formatArguments(binary, args)}`);
    let process = child_process.execFile(binary, args, (error, stdout, stderr) => {
      if (error != null) {
        if (stderr && stderr.toString() != '') this.logger.error(stderr.toString());
        if (stdout && stdout.toString() != '') this.logger.error(stdout.toString());
        this.logger.error(error.toString());
      }
    });
    process.on('close', (code, _signal) => {
      if (code == 0) {
        if (this.showStatusBar) {
          if (!this.showCodingActivity) this.statusBar.text = '$(clock)';
          this.getCodingActivity();
        }
        let today = new Date();
        this.logger.debug(`last heartbeat sent ${this.formatDate(today)}`);
      } else if (code == 102) {
        if (this.showStatusBar) {
          if (!this.showCodingActivity) this.statusBar.text = '$(clock)';
          this.statusBar.tooltip =
            'WakaTime: working offline... coding activity will sync next time we are online';
        }
        this.logger.warn(
          `Api eror (102); Check your ${this.options.getLogFile()} file for more details`,
        );
      } else if (code == 103) {
        let error_msg = `Config parsing error (103); Check your ${this.options.getLogFile()} file for more details`;
        if (this.showStatusBar) {
          this.statusBar.text = '$(clock) WakaTime Error';
          this.statusBar.tooltip = `WakaTime: ${error_msg}`;
        }
        this.logger.error(error_msg);
      } else if (code == 104) {
        let error_msg = 'Invalid Api Key (104); Make sure your Api Key is correct!';
        if (this.showStatusBar) {
          this.statusBar.text = '$(clock) WakaTime Error';
          this.statusBar.tooltip = `WakaTime: ${error_msg}`;
        }
        this.logger.error(error_msg);
      } else {
        let error_msg = `Unknown Error (${code}); Check your ${this.options.getLogFile()} file for more details`;
        if (this.showStatusBar) {
          this.statusBar.text = '$(clock) WakaTime Error';
          this.statusBar.tooltip = `WakaTime: ${error_msg}`;
        }
        this.logger.error(error_msg);
      }
    });
  }

  private getCodingActivity(force: boolean = false) {
    if (!this.showCodingActivity || !this.showStatusBar) return;
    const cutoff = Date.now() - this.fetchTodayInterval;
    if (!force && this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();
    this.getCodingActivityTimeout = setTimeout(this.getCodingActivity, this.fetchTodayInterval);

    this.hasApiKey(hasApiKey => {
      if (!hasApiKey) return;

      if (this.standalone) {
        this._getCodingActivity();
      } else {
        this.dependencies.getPythonLocation(pythonBinary => {
          if (pythonBinary) {
            this._getCodingActivity(pythonBinary);
          }
        });
      }
    });
  }

  private _getCodingActivity(pythonBinary?: string) {
    if (this.standalone && !this.dependencies.isStandaloneCliInstalled()) return;
    let cli = this.standalone
      ? this.dependencies.getStandaloneCliLocation()
      : this.dependencies.getCliLocation();
    let user_agent =
      this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version;
    let args = ['--today', '--plugin', Libs.quote(user_agent)];
    if (!this.standalone) args.unshift(cli);
    if (Dependencies.isWindows()) {
      args.push(
        '--config',
        Libs.quote(this.options.getConfigFile()),
        '--logfile',
        Libs.quote(this.options.getLogFile()),
      );
    }

    const binary = this.standalone || !pythonBinary ? cli : pythonBinary;
    this.logger.debug(
      `Fetching coding activity for Today from api: ${this.formatArguments(binary, args)}`,
    );
    let process = child_process.execFile(binary, args, (error, stdout, stderr) => {
      if (error != null) {
        if (stderr && stderr.toString() != '') this.logger.error(stderr.toString());
        if (stdout && stdout.toString() != '') this.logger.error(stdout.toString());
        this.logger.error(error.toString());
      }
    });
    let output = '';
    if (process.stdout) {
      process.stdout.on('data', (data: string | null) => {
        if (data) output += data;
      });
    }
    process.on('close', (code, _signal) => {
      if (code == 0) {
        if (output && this.showStatusBar && this.showCodingActivity) {
          this.statusBar.text = `$(clock) ${output}`;
          this.statusBar.tooltip = `WakaTime: You coded ${output.trim()} today.`;
        }
      } else if (code == 102) {
        // noop, working offline
      } else {
        let error_msg = `Error fetching today coding activity (${code}); Check your ${this.options.getLogFile()} file for more details`;
        this.logger.debug(error_msg);
      }
    });
  }

  private formatDate(date: Date): String {
    let months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    let ampm = 'AM';
    let hour = date.getHours();
    if (hour > 11) {
      ampm = 'PM';
      hour = hour - 12;
    }
    if (hour == 0) {
      hour = 12;
    }
    let minute = date.getMinutes();
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hour}:${
      minute < 10 ? `0${minute}` : minute
    } ${ampm}`;
  }

  private enoughTimePassed(time: number): boolean {
    return this.lastHeartbeat + 120000 < time;
  }

  private getProjectName(file: string): string {
    let uri = vscode.Uri.file(file);
    let workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (vscode.workspace && workspaceFolder) {
      try {
        return workspaceFolder.name;
      } catch (e) {}
    }
    return '';
  }

  private obfuscateKey(key: string): string {
    let newKey = '';
    if (key) {
      newKey = key;
      if (key.length > 4)
        newKey = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX' + key.substring(key.length - 4);
    }
    return newKey;
  }

  private wrapArg(arg: string): string {
    if (arg.indexOf(' ') > -1) return '"' + arg.replace(/"/g, '\\"') + '"';
    return arg;
  }

  private formatArguments(binary: string, args: string[]): string {
    let clone = args.slice(0);
    clone.unshift(this.wrapArg(binary));
    let newCmds: string[] = [];
    let lastCmd = '';
    for (let i = 0; i < clone.length; i++) {
      if (lastCmd == '--key') newCmds.push(this.wrapArg(this.obfuscateKey(clone[i])));
      else newCmds.push(this.wrapArg(clone[i]));
      lastCmd = clone[i];
    }
    return newCmds.join(' ');
  }
}
