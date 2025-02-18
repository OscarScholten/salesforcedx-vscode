#!/usr/bin/env node

const shell = require('shelljs');
const { checkVSCodeVersion, checkBaseBranch } = require('./validation-utils');
const logger = require('./logger-util');
const changeLogGeneratorUtils = require('./change-log-generator-utils');

shell.set('-e');
shell.set('+v');

function getReleaseType() {
  const releaseTypeIndex = process.argv.indexOf('-r');
  if (releaseTypeIndex > -1) {
    if (!/patch|minor|major/.exec(`${process.argv[releaseTypeIndex + 1]}`)) {
      console.error(
        `Release Type was specified (-r), but received invalid value ${process.argv[releaseTypeIndex + 1]}.
        Accepted Values: 'patch', 'minor', or 'major'`
      );
      process.exit(-1);
    }
    return process.argv[releaseTypeIndex + 1];
  }
  return 'minor';
}

function getReleaseVersion() {
  const currentVersion = require('../packages/salesforcedx-vscode/package.json')
    .version;
  let [version, major, minor, patch] = currentVersion.match(/^(\d+)\.?(\d+)\.?(\*|\d+)$/);

  switch(getReleaseType()) {
    case 'major':
      major = parseInt(major) + 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor = parseInt(minor) + 1;
      patch = 0;
      break;
    case 'patch':
      patch = parseInt(patch) + 1;
      break;
  }
  return `${major}.${minor}.${patch}`;
}

shell.env['SALESFORCEDX_VSCODE_VERSION'] = getReleaseVersion();
checkVSCodeVersion();

const nextVersion = process.env['SALESFORCEDX_VSCODE_VERSION'];
logger.info(`Release version: ${nextVersion}`);
checkBaseBranch('develop');

const releaseBranchName = `release/v${nextVersion}`;

// Check if release branch has already been created
const isRemoteReleaseBranchExist = shell
  .exec(`git ls-remote --heads origin ${releaseBranchName}`, {
    silent: true
  })
  .stdout.trim();

if (isRemoteReleaseBranchExist) {
  logger.error(
    `${releaseBranchName} already exists in remote. You might want to verify the value assigned to SALESFORCEDX_VSCODE_VERSION`
  );
  process.exit(-1);
}

// Create the new release branch and switch to it
shell.exec(`git checkout -b ${releaseBranchName}`);

// git clean but keeping node_modules around
shell.exec('git clean -xfd -e node_modules');

// lerna version
// increment the version number in all packages without publishing to npmjs
// only run on branch named develop and do not create git tags
shell.exec(
  `lerna version ${nextVersion} --force-publish --no-git-tag-version --exact --yes`
);

// Using --no-git-tag-version prevents creating git tags but also prevents commiting
// all the version bump changes so we'll now need to commit those using git add & commit.
// Add all package.json version update changes
shell.exec(`git add "**/package.json"`);

// Add change to lerna.json
shell.exec('git add lerna.json');

// Git commit
shell.exec(`git commit -m "chore: update to version ${nextVersion}"`);

// Merge release branch to develop as soon as it is cut.
// In this way, we can resolve conflicts between main branch and develop branch when merge main back to develop after the release.
shell.exec(`git checkout develop`)
shell.exec(`git merge ${releaseBranchName}`)
shell.exec(`git push -u origin develop`)
shell.exec(`git checkout ${releaseBranchName}`)

// Generate changelog
const previousBranchName = changeLogGeneratorUtils.getPreviousReleaseBranch(releaseBranchName);
const parsedCommits = changeLogGeneratorUtils.parseCommits(changeLogGeneratorUtils.getCommits(releaseBranchName, previousBranchName));
const groupedMessages = changeLogGeneratorUtils.getMessagesGroupedByPackage(parsedCommits, '');
const changeLog = changeLogGeneratorUtils.getChangeLogText(releaseBranchName, groupedMessages);
changeLogGeneratorUtils.writeChangeLog(changeLog);

const commitCommand = `git commit -a -m "chore: generated CHANGELOG for ${releaseBranchName}"`;
shell.exec(commitCommand);

// Push new release branch to remote
shell.exec(`git push -u origin ${releaseBranchName}`);
