/*
 * Copyright (c) 2017, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  Command,
  SfdxCommandBuilder
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { CommandOutput } from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { CliCommandExecutor } from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { EOL } from 'os';
import { Observable } from 'rxjs/Observable';
import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode';
import { channelService } from '../../channels/index';
import { nls } from '../../messages';
import { isDemoMode, isProdOrg } from '../../modes/demo-mode';
import {
  notificationService,
  ProgressNotification
} from '../../notifications/index';
import { taskViewService } from '../../statuses/index';
import { telemetryService } from '../../telemetry';
import { getRootWorkspacePath, isSFDXContainerMode } from '../../util';
import {
  DemoModePromptGatherer,
  SfdxCommandlet,
  SfdxCommandletExecutor,
  SfdxWorkspaceChecker
} from '../util';
import { AuthParams, AuthParamsGatherer } from './authParamsGatherer';
import { ForceAuthLogoutAll } from './forceAuthLogout';

interface DeviceCodeResponse {
  user_code: string;
  device_code: string;
  interval: number;
  verification_uri: string;
}

export class ForceAuthWebLoginContainerExecutor extends SfdxCommandletExecutor<
  AuthParams
> {
  protected showChannelOutput = false;

  public build(data: AuthParams): Command {
    const command = new SfdxCommandBuilder().withDescription(
      nls.localize('force_auth_web_login_authorize_org_text')
    );

    command
      .withArg('force:auth:device:login')
      .withLogName('force_auth_device_login')
      .withFlag('--setalias', data.alias)
      .withFlag('--instanceurl', data.loginUrl)
      .withArg('--setdefaultusername')
      .withJson();

    return command.build();
  }

  public execute(response: ContinueResponse<AuthParams>): void {
    const startTime = process.hrtime();
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;
    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: getRootWorkspacePath(),
      env: { SFDX_JSON_TO_STDOUT: 'true' }
    }).execute(cancellationToken);
    let deviceCodeReceived = false;

    channelService.streamCommandStartStop(execution);

    let stdOut = '';
    execution.stdoutSubject.subscribe(cliResponse => {
      stdOut += cliResponse.toString();

      if (!deviceCodeReceived) {
        const authUrl = this.parseAuthUrlFromStdOut(stdOut);

        if (authUrl) {
          deviceCodeReceived = true;
          // open the default browser
          vscode.env.openExternal(vscode.Uri.parse(authUrl, true));
        }
      }
    });

    execution.processExitSubject.subscribe(() => {
      this.logMetric(execution.command.logName, startTime);
    });

    notificationService.reportCommandExecutionStatus(
      execution,
      cancellationToken
    );

    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }

  private parseAuthUrlFromStdOut(stdOut: string): string | undefined {
    let authUrl;
    try {
      const response = JSON.parse(stdOut) as DeviceCodeResponse;
      const verificationUrl = response.verification_uri;
      const userCode = response.user_code;

      if (verificationUrl && userCode) {
        authUrl = `${verificationUrl}?user_code=${userCode}`;
        this.logToOutputChannel(userCode, verificationUrl);
      }
    } catch (error) {
      channelService.appendLine(
        nls.localize('force_auth_web_login_device_code_parse_error')
      );
      telemetryService.sendException(
        'force_auth_web_container',
        `There was an error when parsing the cli response ${error}`
      );
    }

    return authUrl;
  }

  private logToOutputChannel(code: string, url: string) {
    channelService.appendLine(`${EOL}`);
    channelService.appendLine(nls.localize('action_required'));
    channelService.appendLine(
      nls.localize('force_auth_device_login_enter_code', code, url)
    );
    channelService.appendLine(`${EOL}`);
  }
}

export class ForceAuthWebLoginExecutor extends SfdxCommandletExecutor<
  AuthParams
> {
  protected showChannelOutput = false;

  public build(data: AuthParams): Command {
    const command = new SfdxCommandBuilder().withDescription(
      nls.localize('force_auth_web_login_authorize_org_text')
    );

    command
      .withArg('force:auth:web:login')
      .withLogName('force_auth_web_login')
      .withFlag('--setalias', data.alias)
      .withFlag('--instanceurl', data.loginUrl)
      .withArg('--setdefaultusername');

    return command.build();
  }
}

export abstract class ForceAuthDemoModeExecutor<
  T
> extends SfdxCommandletExecutor<T> {
  public async execute(response: ContinueResponse<T>): Promise<void> {
    const startTime = process.hrtime();
    const cancellationTokenSource = new CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;

    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: getRootWorkspacePath()
    }).execute(cancellationToken);

    execution.processExitSubject.subscribe(() => {
      this.logMetric(execution.command.logName, startTime);
    });

    notificationService.reportExecutionError(
      execution.command.toString(),
      (execution.stderrSubject as any) as Observable<Error | undefined>
    );

    channelService.streamCommandOutput(execution);
    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);

    try {
      const result = await new CommandOutput().getCmdResult(execution);
      if (isProdOrg(JSON.parse(result))) {
        await promptLogOutForProdOrg();
      } else {
        await notificationService.showSuccessfulExecution(
          execution.command.toString()
        );
      }
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

export class ForceAuthWebLoginDemoModeExecutor extends ForceAuthDemoModeExecutor<
  AuthParams
> {
  public build(data: AuthParams): Command {
    return new SfdxCommandBuilder()
      .withDescription(nls.localize('force_auth_web_login_authorize_org_text'))
      .withArg('force:auth:web:login')
      .withFlag('--setalias', data.alias)
      .withFlag('--instanceurl', data.loginUrl)
      .withArg('--setdefaultusername')
      .withArg('--noprompt')
      .withJson()
      .withLogName('force_auth_web_login_demo_mode')
      .build();
  }
}

export async function promptLogOutForProdOrg() {
  await new SfdxCommandlet(
    new SfdxWorkspaceChecker(),
    new DemoModePromptGatherer(),
    ForceAuthLogoutAll.withoutShowingChannel()
  ).run();
}

const workspaceChecker = new SfdxWorkspaceChecker();
const parameterGatherer = new AuthParamsGatherer();

export function createAuthWebLoginExecutor(): SfdxCommandletExecutor<{}> {
  switch (true) {
    case isSFDXContainerMode():
      return new ForceAuthWebLoginContainerExecutor();
    case isDemoMode():
      return new ForceAuthWebLoginDemoModeExecutor();
    default:
      return new ForceAuthWebLoginExecutor();
  }
}

export async function forceAuthWebLogin() {
  const commandlet = new SfdxCommandlet(
    workspaceChecker,
    parameterGatherer,
    createAuthWebLoginExecutor()
  );
  await commandlet.run();
}
