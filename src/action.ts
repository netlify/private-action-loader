import * as exec from '@actions/exec';
import * as core from '@actions/core';
import { parse } from 'yaml';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { sync as rimrafSync } from 'rimraf';

export function setInputs(action: any): void {
  if (!action.inputs) {
    core.info('No inputs defined in action.');
    return;
  }

  core.info(`The configured inputs are ${Object.keys(action.inputs)}`);

  for (const i of Object.keys(action.inputs)) {
    const formattedInputName = `INPUT_${i.toUpperCase()}`;

    if (process.env[formattedInputName]) {
      core.info(`Input ${i} already set`);
      continue;
    } else if (!action.inputs[i].required && !action.inputs[i].default) {
      core.info(`Input ${i} not required and has no default`);
      continue;
    } else if (action.inputs[i].required && !action.inputs[i].default) {
      core.error(`Input ${i} required but not provided and no default is set`);
    }

    core.info(`Input ${i} not set.  Using default '${action.inputs[i].default}'`);
    process.env[formattedInputName] = action.inputs[i].default;
  }
}

export async function runAction(opts: {
  token: string;
  repoName: string;
  workDirectory: string;
  actionDirectory?: string;
  post: boolean;
}): Promise<void> {
  const [repo, sha] = opts.repoName.split('@');
  const repoUrl = `https://${opts.token}@github.com/${repo}.git`;
  const repoPathSafeName = repo.replace(/[^a-zA-Z0-9]/, '_');
  const repoDirectory = join(opts.workDirectory, repoPathSafeName);

  core.info('Masking token just in case');
  core.setSecret(opts.token);

  core.startGroup('Cloning private action');
  if (existsSync(repoDirectory)) {
    core.info(`Repo is already cloned.`);
  } else {
    const cmd = ['git clone', repoUrl, repoDirectory].join(' ');

    core.info(
      `Cloning action from https://***TOKEN***@github.com/${repo}.git${sha ? ` (SHA: ${sha})` : ''}`
    );
    await exec.exec(cmd);

    core.info('Remove github token from config');
    await exec.exec(`git remote set-url origin https://github.com/${repo}.git`, undefined, {
      cwd: repoDirectory,
    });
  }

  if (sha) {
    core.info(`Checking out ${sha}`);
    await exec.exec(`git checkout ${sha}`, undefined, { cwd: repoDirectory });
  }

  // if actionDirectory specified, join with repoDirectory (for use when multiple actions exist in same repo)
  // if actionDirectory not specified, use repoDirectory (for repo with a single action at root)
  const actionPath = opts.actionDirectory
    ? join(repoDirectory, opts.actionDirectory)
    : repoDirectory;

  core.info(`Reading ${actionPath}`);
  const actionFile = readFileSync(`${actionPath}/action.yml`, 'utf8');
  const action = parse(actionFile);

  if (!(action && action.name && action.runs && action.runs.main)) {
    throw new Error('Malformed action.yml found');
  }
  core.endGroup();

  core.startGroup('Input Validation');
  setInputs(action);
  core.endGroup();

  if (opts.post) {
    if (!action.runs.post) {
      core.info(`Action has no 'post' step`);
    } else {
      let postIf = action.runs['post-if'];
      if (postIf && postIf !== 'always()') {
        throw new Error(
          `Action has post-if that isn't empty or 'always()': that's not supported yet`
        );
      }

      core.info(`Running post for action ${action.nam}`);
      await exec.exec(`node ${join(actionPath, action.runs.post)}`);
    }

    core.info(`Cleaning up repo directory`);
    rimrafSync(repoDirectory);
  } else {
    core.info(`Running main for action ${action.name}`);
    await exec.exec(`node ${join(actionPath, action.runs.main)}`);
  }
}
