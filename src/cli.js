#!/usr/bin/env node

const { program } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { install, remove, addRepo, removeRepo, update, config, listInstalledApps, getPawInfo } = require('./commands');
const { version } = require('../package.json');

// Get the config file path directly
const CONFIG_DIR = path.join(os.homedir(), '.pawkit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

program
  .name('pawkit')
  .description('PawKit - A streamlined application and paw installer framework')
  .version(version)
  .option('-d, --debug', 'Show detailed debug information');

// Add a global handler to set the debug environment variable if the global option is used
program.hook('preAction', (thisCommand, actionCommand) => {
  const options = thisCommand.opts();
  if (options.debug) {
    process.env.PAWKIT_DEBUG = 'true';
  }
});

// Add a global handler to clean up environment variables after command execution
program.hook('postAction', () => {
  delete process.env.PAWKIT_DEBUG;
});

program
  .command('install [paws...]')
  .alias('i')
  .description('Install one or more paws from a .Paw file or a repository')
  .option('-f, --force', 'Skip confirmation prompt and allow overwriting existing files')
  .action(async (paws, options) => {
    try {
      // Set environment variables based on options
      if (options.force) {
        process.env.PAWKIT_FORCE_INSTALL = 'true';
      }
      
      // Handle multiple paws
      if (paws.length === 0) {
        console.error(chalk.red('Error: No paws specified for installation'));
        process.exit(1);
      }
      
      // Process each paw
      for (const paw of paws) {
        try {
          console.log(chalk.blue(`\nInstalling paw: ${paw}`));
          await install(paw);
        } catch (error) {
          console.error(chalk.red(`\nError installing ${paw}: ${error.message}`));
          // Continue with next paw instead of exiting
        }
      }
      
      // Clean up environment variables
      delete process.env.PAWKIT_FORCE_INSTALL;
    } catch (error) {
      // Clean up environment variables even on error
      delete process.env.PAWKIT_FORCE_INSTALL;
      
      console.error(chalk.red(`\nError during installation: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('delete [paws...]')
  .alias('d', 'remove', 'uninstall')
  .description('Uninstall one or more paws using cached metadata')
  .action(async (paws) => {
    try {
      // Check if any paws were specified
      if (paws.length === 0) {
        console.error(chalk.red('Error: No paws specified for removal'));
        process.exit(1);
      }
      
      // Process each paw
      for (const paw of paws) {
        try {
          console.log(chalk.blue(`\nRemoving paw: ${paw}`));
          await remove(paw);
        } catch (error) {
          console.error(chalk.red(`\nError removing ${paw}: ${error.message}`));
          // Continue with next paw instead of exiting
        }
      }
    } catch (error) {
      console.error(chalk.red(`\nError during removal process: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('info [pawName]')
  .alias('inf')
  .description('Show detailed information about an installed paw')
  .action(async (pawName) => {
    try {
      await getPawInfo(pawName);
    } catch (error) {
      console.error(chalk.red(`Error getting paw info: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('addrepo <url>')
  .description('Add a repository to the list of available repositories')
  .action(async (url) => {
    try {
      await addRepo(url);
    } catch (error) {
      console.error(chalk.red(`Error adding repository: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('removerepo <name>')
  .description('Remove a repository from the list')
  .action(async (name) => {
    try {
      await removeRepo(name);
    } catch (error) {
      console.error(chalk.red(`Error removing repository: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('update [target]')
  .alias('u', 'up')
  .description('Update paws or repositories (use "all" to update everything)')
  .action(async (target = 'all') => {
    try {
      await update(target);
    } catch (error) {
      console.error(chalk.red(`Error updating: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('config [action] [key] [value]')
  .description('Manage configuration (get/set configuration values)')
  .action(async (action = 'get', key, value) => {
    try {
      await config(action, key, value);
    } catch (error) {
      console.error(chalk.red(`Error with config: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('list')
  .alias('ls')
  .description('List all installed paws')
  .action(async () => {
    try {
      await listInstalledApps();
    } catch (error) {
      console.error(chalk.red(`Error listing installed paws: ${error.message}`));
      process.exit(1);
    }
  });

// Add command aliases for common operations
program
  .command('finstall <paw>')
  .aliases(['fi', 'f'])  // Short aliases for convenience
  .description('Force install a paw (skip confirmation and allow overwriting files)')
  .action(async (paw, options) => {
    try {
      // Set environment variable to force installation
      process.env.PAWKIT_FORCE_INSTALL = 'true';
      
      // Call the actual install function
      await install(paw);
      
      // Clean up environment variables
      delete process.env.PAWKIT_FORCE_INSTALL;
    } catch (error) {
      // Clean up environment variables even on error
      delete process.env.PAWKIT_FORCE_INSTALL;
      
      console.error(chalk.red(`Error installing paw: ${error.message}`));
      process.exit(1);
    }
  });

program.parse(); 