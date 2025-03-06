const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const os = require('os');
const child_process = require('child_process');
const { debuglog } = require('util');
const { spawnSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.pawkit');
const REPOS_FILE = path.join(CONFIG_DIR, 'repos.json');
const PAWS_FILE = path.join(CONFIG_DIR, 'paws.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Helper function to properly set macOS symlink attributes if needed
const ensureProperSymlinkAttributes = (symlinkPath) => {
  // Only for macOS
  if (process.platform !== 'darwin') {
    return;
  }
  
  try {
    // Try to use xattr to set the symlink type if available
    child_process.execSync(`xattr -w com.apple.FinderInfo '0000000000000000000400000000000000000000000000000000000000000000' "${symlinkPath}"`, { stdio: 'ignore' });
    debugLog(chalk.blue(`✓ Set macOS symlink attributes for ${symlinkPath}`));
  } catch (error) {
    // Ignore errors with xattr, as it's just an enhancement
    debugLog(chalk.yellow(`⚠️ Could not set macOS symlink attributes: ${error.message}`));
  }
};

// Debug log helper function
function debugLog(...args) {
  try {
    const config = fs.readJsonSync(CONFIG_FILE);
    const debugEnabled = config.debug || process.env.PAWKIT_DEBUG === 'true';
    if (debugEnabled) {
      console.log(...args);
    }
  } catch (error) {
    // If we can't read config, default to not showing debug logs
  }
}

// Define special path mappings
const USER_HOME = os.homedir();
const specialPaths = {
  '@userhome': USER_HOME,
  '@documents': path.join(USER_HOME, 'Documents'),
  '@document': path.join(USER_HOME, 'Documents'),
  '@docs': path.join(USER_HOME, 'Documents'),
  '@applicationSupport': path.join(USER_HOME, 'Library', 'Application Support'),
  '@applicationsupport': path.join(USER_HOME, 'Library', 'Application Support'),
  '@desktop': path.join(USER_HOME, 'Desktop'),
  '@downloads': path.join(USER_HOME, 'Downloads'),
  '@applications': '/Applications',
  '@userapplications': path.join(USER_HOME, '/Applications'),
  '@library': path.join(USER_HOME, 'Library'),
  '@preferences': path.join(USER_HOME, 'Library', 'Preferences'),
};

// Ensure config directory exists
fs.ensureDirSync(CONFIG_DIR);

// Initialize config files if they don't exist
if (!fs.existsSync(REPOS_FILE)) {
  fs.writeJsonSync(REPOS_FILE, { repositories: [] });
}
if (!fs.existsSync(PAWS_FILE)) {
  fs.writeJsonSync(PAWS_FILE, { installed: {} });
}
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeJsonSync(CONFIG_FILE, { 
    confirm_installation: true,  // Default to requiring confirmation
    verbose_logging: false,
    debug: false  // Enable for detailed error messages
  });
}

// Function to check if a file is a valid zip archive
function isValidZipFile(filePath) {
  try {
    // Check for zip file signature (PK magic number)
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    
    // ZIP files start with PK signature (0x50 0x4B 0x03 0x04)
    return buffer[0] === 0x50 && buffer[1] === 0x4B && 
           (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && 
           (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
  } catch (error) {
    return false;
  }
}

async function install(pawPath) {
  // Create a spinner but don't start it yet
  const spinner = ora('Preparing to install paw...');
  
  try {
    // Start spinner
    spinner.start();
    
    // Load config to check debug setting
    const config = fs.readJsonSync(CONFIG_FILE);
    
    // Check for environment variables that override config
    if (process.env.PAWKIT_FORCE_INSTALL === 'true') {
      config.confirm_installation = false;
    }
    
    if (process.env.PAWKIT_DEBUG === 'true') {
      config.debug = true;
    }
    
    const debug = config.debug || false;
    
    let result;
    if (pawPath.endsWith('.paw')) {
      spinner.text = 'Reading package file...';
      result = await installFromFile(pawPath, spinner);
    } else {
      spinner.text = 'Fetching from repository...';
      result = await installFromRepo(pawPath, spinner);
    }
    
    // Show success message without spinner
    spinner.stop();
    console.log(chalk.green('\n✨ Paw installed successfully!'));
    return result;
  } catch (error) {
    // Clear spinner
    spinner.stop();
    
    // Check if we should show detailed error info
    try {
      const config = fs.readJsonSync(CONFIG_FILE);
      if (config.debug) {
        console.error(chalk.red('\nDetailed error information:'));
        console.error(chalk.red(error.stack || error));
      }
    } catch (configError) {
      // If we can't read config, just show normal error
    }
    
    throw error;
  }
}

async function installFromFile(filePath, spinner) {
    debugLog(chalk.blue(`🐾 Analyzing paw from ${filePath}`));
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    // Validate it's a zip file
    spinner.text = 'Validating package format...';
    if (!isValidZipFile(filePath)) {
      throw new Error(`Invalid paw file: ${filePath} is not a valid zip file`);
    }
    
    // Create temp directory for installation
    spinner.text = 'Creating temporary workspace...';
    const tempInstallDir = path.join(os.tmpdir(), `pawkit-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`);
    const tempFile = path.join(tempInstallDir, 'paw.paw');
    
    try {
      // Create temp directory and copy file
      fs.ensureDirSync(tempInstallDir);
      fs.copyFileSync(filePath, tempFile);

      // Create extraction directory
      const extractDir = path.join(tempInstallDir, 'extracted');
      fs.ensureDirSync(extractDir);
      
      spinner.text = 'Reading package metadata...';
      
      // Try to read metadata first using AdmZip (just for metadata, not extraction)
      let metadata = { name: path.basename(filePath, '.paw'), version: '0.0.0' };
      
      // First try to read metadata if it exists
      try {
        debugLog(chalk.blue('📄 Checking for metadata...'));
        
        // Create AdmZip instance just to read metadata
        const metadataZip = new AdmZip(tempFile);
        let metadataContent = metadataZip.readAsText('metadata/data.json');
        
        // If not found at root, try in a subdirectory named after the package
        if (!metadataContent) {
          const pawName = path.basename(filePath, '.paw');
          metadataContent = metadataZip.readAsText(`${pawName}/metadata/data.json`);
          debugLog(chalk.blue(`📄 Looking for metadata in alternate location: ${pawName}/metadata/data.json`));
        }
        
        if (metadataContent) {
          try {
            const parsedMetadata = JSON.parse(metadataContent);
            metadata = { ...metadata, ...parsedMetadata };
            
            // If we found a version in the metadata, use it
            if (metadata.version && metadata.version !== '0.0.0') {
              spinner.succeed(`Found metadata version ${metadata.version}`);
              spinner.start('Extracting package...');
            } else {
              spinner.warn('Paw metadata is missing a valid version, using default 0.0.0');
              spinner.start('Extracting package...');
              metadata.version = '0.0.0';
            }
            
            debugLog(chalk.green('✓ Found metadata:', metadata));
          } catch (parseError) {
            spinner.warn(`Error parsing metadata JSON: ${parseError.message}`);
            spinner.start('Extracting package...');
            metadata.version = '0.0.0';
          }
        } else {
          spinner.warn('No metadata found in paw, using version 0.0.0');
          spinner.start('Extracting package...');
          metadata.version = '0.0.0';
        }
      } catch (error) {
        spinner.warn('No metadata found, using version 0.0.0');
        spinner.start('Extracting package...');
        metadata.version = '0.0.0';
      }
      
      // Now extract the files - try to use native tools first if available
      debugLog(chalk.blue(`🐾 Extracting to temporary directory: ${extractDir}`));
      spinner.text = 'Extracting package contents...';
      
      let useNativeExtraction = false;
      
      // On macOS, try to use the native unzip command which preserves symlinks and permissions
      if (process.platform === 'darwin') {
        try {
          debugLog(chalk.blue('🔧 Attempting to use macOS native unzip for better symlink and permission preservation'));
          
          // First check if unzip is available
          child_process.execSync('which unzip', { stdio: 'ignore' });
          
          // Use the best options for preserving symlinks and attributes
          const unzipCommand = `unzip -X -o -K "${tempFile}" -d "${extractDir}"`;
          debugLog(chalk.blue(`Executing: ${unzipCommand}`));
          
          child_process.execSync(unzipCommand, { stdio: 'pipe' });
          spinner.succeed('Package contents extracted');
          
          useNativeExtraction = true;
        } catch (error) {
          spinner.warn(`Native unzip failed, falling back to AdmZip: ${error.message}`);
          useNativeExtraction = false;
        }
      }
      
      // Fallback to AdmZip if native extraction failed or not on macOS
      if (!useNativeExtraction) {
        debugLog(chalk.blue('🐾 Using AdmZip for extraction'));
        try {
          const zip = new AdmZip(tempFile);
          zip.extractAllTo(extractDir, true);
          spinner.succeed('Package contents extracted');
        } catch (error) {
          spinner.fail(`Error extracting paw file: ${error.message}`);
          throw new Error(`Failed to extract paw: ${error.message}`);
        }
      }
      
      // Read files from extracted directory
      const entries = [];
      const readDir = (dir) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const relativePath = path.relative(extractDir, fullPath).replace(/\\/g, '/');
          
          // Use lstat instead of stat to detect symlinks
          const stat = fs.lstatSync(fullPath);
          
          if (stat.isSymbolicLink()) {
            // Track symlinks separately
            const linkTarget = fs.readlinkSync(fullPath);
            debugLog(chalk.blue(`🔗 Found symlink during extraction: ${relativePath} -> ${linkTarget}`));
            
            // Check if this is a relative symlink - if so, make it absolute relative to its location
            // This ensures symlinks work properly when installed in a different location
            let resolvedTarget = linkTarget;
            if (!path.isAbsolute(linkTarget)) {
              // For relative symlinks, resolve the target relative to the symlink's directory
              resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
              debugLog(chalk.blue(`🔗 Resolved relative symlink to: ${resolvedTarget}`));
            }
            
            entries.push({
              entryName: relativePath,
              fullPath: fullPath,
              isDirectory: false,
              isSymlink: true,
              linkTarget: linkTarget,
              resolvedTarget: resolvedTarget
            });
          } else if (stat.isFile()) {
            entries.push({
              entryName: relativePath,
              fullPath: fullPath,
              isDirectory: false,
              isSymlink: false
            });
          } else if (stat.isDirectory()) {
            readDir(fullPath);
          }
        }
      };
    
    readDir(extractDir);

    // Debug: Print all entries
    debugLog(chalk.gray('📝 Available entries:'));
    entries.forEach(entry => {
      debugLog(chalk.gray(`  - ${entry.entryName}`));
    });
    
    // Filter out macOS system files and get valid entries
    let osFiles = entries.filter(entry => {
      // Skip macOS system files and directories
      if (entry.entryName.includes('__MACOSX') || 
          entry.entryName.endsWith('.DS_Store') || 
          entry.entryName.includes('/._')) {
        debugLog(chalk.yellow(`⚠️  Skipping system file: ${entry.entryName}`));
        return false;
      }

      // Clean up the entry name
      const cleanPath = cleanAndMapPath(entry.entryName);
      
      debugLog(chalk.gray(`  Cleaned path: ${cleanPath}`));

      // Check if it's a valid file
      const isValidFile = cleanPath !== null;

      if (isValidFile) {
        debugLog(chalk.green(`  ✓ Found valid file: ${cleanPath}`));
      }

      return isValidFile;
    });
    
    // If no valid files found, try using all files except metadata and system files
    if (osFiles.length === 0) {
      debugLog(chalk.yellow('⚠️  No valid files found with @* prefixes, checking for files that can be mapped'));
      
      // First, try to see if there are files that could be mapped with @* prefixes
      const filesWithPotentialPrefixes = entries.filter(entry => {
        // Skip system files
        if (entry.entryName.includes('__MACOSX') ||
            entry.entryName.endsWith('.DS_Store') ||
            entry.entryName.includes('/._')) {
          return false;
        }
        
        // Skip metadata files
        if (entry.entryName.startsWith('metadata/')) {
          return false;
        }
        
        return true;
      });
      
      if (filesWithPotentialPrefixes.length > 0) {
        console.log(chalk.yellow('⚠️  Found files but they don\'t use @* prefixes. All files must use one of these prefixes:'));
        console.log(chalk.yellow(`  ${Object.keys(specialPaths).join(', ')}`));
        console.log(chalk.yellow('Example: @documents/myfile.txt'));
        
        // Show some examples of files that were rejected
        const examples = filesWithPotentialPrefixes.slice(0, 3).map(entry => entry.entryName);
        console.log(chalk.yellow(`Files found without proper prefixes (examples): ${examples.join(', ')}`));
        
        throw new Error('Installation failed: Files must use @* prefixes');
      }
      
      console.log(chalk.red('❌ No valid files found to install'));
      throw new Error('No valid files found to install');
    }
    
    // Filter out any remaining directories
    const filesToInstall = osFiles;
    
    if (filesToInstall.length === 0) {
      console.log(chalk.red('❌ No valid files found to install'));
      throw new Error('No valid files found to install');
    }
    
    // Map files to their target paths and source paths in temp directory
    const installPaths = filesToInstall.map(entry => ({
      source: entry.fullPath,
      target: cleanAndMapPath(entry.entryName),
      isSymlink: entry.isSymlink || false,
      linkTarget: entry.linkTarget,
      sourceStats: fs.lstatSync(entry.fullPath) // Preserve the original stats including permissions
    })).filter(file => file.target !== null);
    
    // Check if we filtered out all files
    if (installPaths.length === 0) {
      console.log(chalk.red('❌ No valid files found to install - all paths must use @* prefixes'));
      throw new Error('No valid files found to install - all paths must use @* prefixes');
    }
    
    // Check if any files already exist in the target location
    const existingFiles = [];
    
    for (const file of installPaths) {
      // Skip metadata files when checking for existing files
      if (fs.existsSync(file.target) && !file.target.includes(path.join(CONFIG_DIR, 'pluginmetadata'))) {
        existingFiles.push(file.target);
      }
    }
    
    // Check for existing files
    const forceInstall = process.env.PAWKIT_FORCE_INSTALL === 'true';
    
    // If files exist and we're not forcing, don't install
    if (existingFiles.length > 0 && !forceInstall) {
      console.log(chalk.red(`⚠️ Installation would overwrite existing files:`));
      existingFiles.forEach(file => console.log(chalk.red(`  - ${file}`)));
      throw new Error(`Installation cancelled: ${existingFiles.length} files already exist. Use -f or --force to overwrite.`);
    } else if (existingFiles.length > 0) {
      // If force install is enabled, just warn but continue
      console.log(chalk.yellow(`⚠️ Force installing will overwrite ${existingFiles.length} existing files:`));
      existingFiles.forEach(file => console.log(chalk.yellow(`  - ${file}`)));
    }

    // Load config to check if confirmation is required
    const config = fs.readJsonSync(CONFIG_FILE);
    
    // Skip confirmation if force install is enabled
    if (config.confirm_installation && !forceInstall) {
      // Show installation plan and ask for confirmation
      console.log(chalk.blue(`\n📋 Installation plan for ${metadata.name} v${metadata.version || 'unknown'}:`));
      console.log(chalk.blue(`  Total files to install: ${filesToInstall.length}`));
      
      // Remove duplicate target paths for cleaner display
      const uniqueTargetPaths = new Set();
      const uniqueInstallPaths = [];
      
      for (const file of installPaths) {
        if (!uniqueTargetPaths.has(file.target)) {
          uniqueTargetPaths.add(file.target);
          uniqueInstallPaths.push(file);
        }
      }
      
      // Show first 10 files, then a summary if there are more
      const displayLimit = 10;
      uniqueInstallPaths.slice(0, displayLimit).forEach(file => {
        console.log(chalk.blue(`  - ${file.target}`));
      });
      
      if (uniqueInstallPaths.length > displayLimit) {
        console.log(chalk.blue(`  - ... and ${uniqueInstallPaths.length - displayLimit} more files`));
      }
      
      // Use a simpler approach for confirmation
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      // Use a simple prompt with synchronous wait
      process.stdout.write(chalk.yellow('\nProceed with installation? (y/n): '));
      
      const answer = await new Promise(resolve => {
        process.stdin.once('data', (data) => {
          const input = data.toString().trim().toLowerCase();
          rl.close();
          resolve(input);
        });
      });
      
      if (answer !== 'y' && answer !== 'yes') {
        console.log(chalk.yellow('\nInstallation cancelled by user'));
        throw new Error('Installation cancelled by user');
      }
      
      console.log(chalk.green('\n✓ Proceeding with installation'));
    }
    
    console.log(chalk.blue(`📋 Installing ${filesToInstall.length} files:`));
    
    // Track created directories to avoid redundant operations
    const createdDirs = new Set();
    
    // Function to check if a path is part of an application bundle
    const isAppBundlePath = (path) => {
      return path.includes('.app/Contents/');
    };
    
    // Function to get the root .app path from any file inside the bundle
    const getAppBundleRoot = (filePath) => {
      const appIndex = filePath.indexOf('.app');
      if (appIndex !== -1) {
        return filePath.substring(0, appIndex + 4);
      }
      return null;
    };
    
    // Map of app bundles to their root paths
    const appBundles = new Map();
    
    // First pass - identify app bundles and group files by app
    for (const file of installPaths) {
      const targetPath = file.target;
      if (isAppBundlePath(targetPath)) {
        const appPath = getAppBundleRoot(targetPath);
        if (appPath && !appBundles.has(appPath)) {
          appBundles.set(appPath, {
            files: [],
            sourceDirs: new Set()
          });
        }
        if (appPath) {
          appBundles.get(appPath).files.push(file);
          // Also track source directories to find the root source directory
          const sourceDir = path.dirname(file.source);
          appBundles.get(appPath).sourceDirs.add(sourceDir);
        }
      }
    }
    
    // Track which files have been handled by app bundle installation
    const handledByAppBundle = new Set();
    
    // Process app bundles separately using ditto if available
    if (appBundles.size > 0) {
      console.log(chalk.blue(`📱 Found ${appBundles.size} application bundles to install`));
      
      // On macOS, we'll always try to use ditto
      let dittoAvailable = false;
      if (process.platform === 'darwin') {
        try {
          child_process.execSync('which ditto', { stdio: 'ignore' });
          dittoAvailable = true;
          console.log(chalk.green('✓ Found ditto command for app bundle installation (preserves all metadata and symlinks)'));
        } catch (error) {
          console.log(chalk.red('❌ ditto command not available on this macOS system - cannot install app bundles properly'));
          console.log(chalk.yellow('⚠️ App bundles will be skipped - only individual files will be installed'));
        }
      } else {
        console.log(chalk.yellow('⚠️ Not running on macOS, app bundles will be installed as individual files'));
      }
      
      // Process each app bundle
      for (const [appPath, bundleInfo] of appBundles.entries()) {
        // Skip if ditto isn't available - this ensures we don't try to install app bundles without ditto
        if (!dittoAvailable) {
          console.log(chalk.yellow(`⚠️ Skipping app bundle installation for ${appPath} - will install files individually`));
          continue;
        }
        
        console.log(chalk.blue(`🐾 Installing application bundle: ${appPath}`));
        
        // Create parent directory for the app
        const appDir = path.dirname(appPath);
        if (!createdDirs.has(appDir)) {
          debugLog(chalk.blue(`📁 Creating app directory: ${appDir}`));
          fs.ensureDirSync(appDir);
          console.log(chalk.green(`✓ Created directory: ${appDir}`));
          createdDirs.add(appDir);
        }
        
        // For macOS, use ditto for app bundles - we've already checked dittoAvailable above
        if (process.platform === 'darwin') {
          const succeeded = await installAppBundle(appPath, bundleInfo);
          
          if (succeeded) {
            // Mark these files as handled so we don't process them individually
            bundleInfo.files.forEach(file => handledByAppBundle.add(file));
          } else {
            console.log(chalk.yellow(`⚠️ App bundle installation failed for ${appPath} - will try individual files`));
          }
        }
      }
    }
    
    // Install remaining individual files
    for (const file of installPaths) {
      // Skip files that were already handled by app bundle installation
      if (handledByAppBundle.has(file)) {
        debugLog(chalk.blue(`🐾 Skipping file already installed as part of app bundle: ${file.target}`));
        continue;
      }
      
      const targetPath = file.target;
      const sourcePath = file.source;
      
      // Create parent directory if needed
      const dirPath = path.dirname(targetPath);
      if (!createdDirs.has(dirPath)) {
        debugLog(chalk.blue(`📁 Creating directory: ${dirPath}`));
        fs.ensureDirSync(dirPath);
        console.log(chalk.green(`✓ Created directory: ${dirPath}`));
        createdDirs.add(dirPath);
      }
      
      try {
        // Check if this file is already marked as a symlink from our earlier detection
        if (file.isSymlink && file.linkTarget) {
          // If it's a symlink, preserve the link by creating a new symlink
          debugLog(chalk.blue(`🔗 Installing symlink from extraction data: ${sourcePath}`));
          
          // Get the appropriate link target
          const linkTarget = file.linkTarget;
          const resolvedTarget = file.resolvedTarget || linkTarget;
          debugLog(chalk.blue(`🔗 Original target of symlink is: ${linkTarget}`));
          
          // Check if this is a relative or absolute symlink
          const isRelative = !path.isAbsolute(linkTarget);
          
          // If the target already exists, remove it first
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          
          // Create the symlink at the target location
          // For relative symlinks, we should preserve the relative path
          // For absolute symlinks, we'll use the original target
          if (isRelative) {
            // For relative symlinks, we need to recreate the relative path
            // from the new target location to match the original relative structure
            const targetDir = path.dirname(targetPath);
            // Use the original relative path directly
            debugLog(chalk.blue(`🔗 Creating relative symlink: ${targetPath} -> ${linkTarget} (relative)`));
            fs.symlinkSync(linkTarget, targetPath);
          } else {
            // For absolute symlinks, use the original target
            debugLog(chalk.blue(`🔗 Creating absolute symlink: ${targetPath} -> ${resolvedTarget} (absolute)`));
            fs.symlinkSync(resolvedTarget, targetPath);
          }
          
          // Helper function to properly set macOS symlink attributes if needed
          ensureProperSymlinkAttributes(targetPath);
          
          console.log(chalk.green(`✓ Installed symlink: ${targetPath} -> ${isRelative ? linkTarget : resolvedTarget}`));
        } else {
          // Double-check if the source is a symlink (in case it wasn't caught during extraction)
          const sourceStat = fs.lstatSync(sourcePath);
          
          if (sourceStat.isSymbolicLink()) {
            // If it's a symlink, preserve the link by creating a new symlink
            debugLog(chalk.blue(`🔗 Found symlink during installation: ${sourcePath}`));
            
            // Get the link target
            const linkTarget = fs.readlinkSync(sourcePath);
            debugLog(chalk.blue(`🔗 Target of symlink is: ${linkTarget}`));
            
            // Check if this is a relative or absolute symlink
            const isRelative = !path.isAbsolute(linkTarget);
            
            // If the target already exists, remove it first
            if (fs.existsSync(targetPath)) {
              fs.unlinkSync(targetPath);
            }
            
            // For relative symlinks, preserve the relative path
            // For absolute symlinks, use the original path
            if (isRelative) {
              // Use the original relative path directly
              debugLog(chalk.blue(`🔗 Creating relative symlink: ${targetPath} -> ${linkTarget} (relative)`));
              fs.symlinkSync(linkTarget, targetPath);
            } else {
              // For absolute symlinks, use the resolved target
              const resolvedTarget = linkTarget; // It's already absolute
              debugLog(chalk.blue(`🔗 Creating absolute symlink: ${targetPath} -> ${resolvedTarget} (absolute)`));
              fs.symlinkSync(resolvedTarget, targetPath);
            }
            
            // Helper function to properly set macOS symlink attributes if needed
            ensureProperSymlinkAttributes(targetPath);
            
            console.log(chalk.green(`✓ Installed symlink: ${targetPath} -> ${linkTarget}`));
          } else {
            // Install file by copying from temp directory
            debugLog(chalk.blue(`📄 Installing file from ${sourcePath} to ${targetPath}`));
            
            // Preserve executable bits by explicitly copying the mode
            // First we copy the file normally
            fs.copyFileSync(sourcePath, targetPath);
            
            // Set file permissions using the stored stats if available, or get them now
            const sourceStats = file.sourceStats || fs.statSync(sourcePath);
            const originalMode = sourceStats.mode;
            
            // For debugging, show the original mode in octal
            debugLog(chalk.blue(`📄 Original file mode: ${originalMode.toString(8)}`));
            
            // Always preserve source permissions for all files
            try {
              // On macOS we might need to explicitly set executable bit
              if (process.platform === 'darwin' && (originalMode & 0o111)) {
                // This is executable in source, ensure it's executable in destination
                const execMode = originalMode | 0o111; // Force executable bits on
                fs.chmodSync(targetPath, execMode);
                debugLog(chalk.blue(`🔑 Set explicit executable permissions for ${targetPath} (mode: ${execMode.toString(8)})`));
              } else {
                // For non-executable or non-macOS, just preserve original mode
                fs.chmodSync(targetPath, originalMode);
                debugLog(chalk.blue(`📄 Preserved file permissions for ${targetPath} (mode: ${originalMode.toString(8)})`));
              }
            } catch (permError) {
              debugLog(chalk.yellow(`⚠️ Could not set permissions for ${targetPath}: ${permError.message}`));
            }
            
            console.log(chalk.green(`✓ Installed file: ${targetPath}${originalMode & 0o111 ? ' (executable)' : ''}`));
          }
        }
      } catch (error) {
        console.log(chalk.red(`❌ Failed to install file ${targetPath}: ${error.message}`));
        throw new Error(`Failed to install file ${targetPath}: ${error.message}`);
      }
    }
    
    // Use Set to ensure unique files
    const installedFiles = Array.from(new Set(
      filesToInstall.map(entry => cleanAndMapPath(entry.entryName))
                    .filter(path => path !== null)
    ));
    
    // Ensure we log the correct version that's being saved
    debugLog(chalk.blue(`📋 Saving metadata for ${metadata.name} with version: ${metadata.version}`));
    
    const paws = fs.readJsonSync(PAWS_FILE);
    paws.installed[metadata.name] = {
      version: metadata.version,
      installDate: new Date().toISOString(),
      files: installedFiles,
      metadata: metadata // Store the complete metadata
    };
    fs.writeJsonSync(PAWS_FILE, paws);
    debugLog(chalk.green('✓ Saved paw metadata'));
    
    console.log(chalk.green(`\n✨ Successfully installed ${metadata.name} v${metadata.version}`));
    console.log(chalk.blue(`🐾 Total files installed: ${installedFiles.length}`));
  } catch (error) {
    // Cleanup temp directory in case of error
    try {
      if (fs.existsSync(tempInstallDir)) {
        fs.removeSync(tempInstallDir);
        debugLog(chalk.gray(`🧹 Cleaned up temporary directory: ${tempInstallDir}`));
      }
    } catch (cleanupError) {
      debugLog(chalk.red(`Failed to cleanup temp directory: ${cleanupError.message}`));
    }
    throw error;
  }
}

async function installFromRepo(pawName, spinner) {
  const repos = fs.readJsonSync(REPOS_FILE);
  let found = false;
  let lastError = null;
  let pawVersion = null;
  
  // Make sure spinner is started
  if (!spinner.isSpinning) {
    spinner.start();
  }
  spinner.text = 'Searching repositories...';
  
  for (const repo of repos.repositories) {
    try {
      // Use spinner.text to update message while keeping animation
      spinner.text = `Checking repository: ${repo.name}`;
      
      let repoData;
      
      // Handle file:// protocol separately
      if (repo.url.startsWith('file://')) {
        const filePath = repo.url.replace('file://', '');
        if (!fs.existsSync(filePath)) {
          // Use warn but then restart spinner
          spinner.warn(`Repository file not found: ${filePath}`);
          spinner.start('Continuing search...');
          continue;
        }
        try {
          spinner.text = `Reading local repository: ${repo.name}`;
          const fileContent = fs.readFileSync(filePath, 'utf8');
          repoData = JSON.parse(fileContent);
        } catch (error) {
          spinner.warn(`Failed to parse repository file: ${error.message}`);
          spinner.start('Continuing search...');
          continue;
        }
      } else {
        // Use axios for http/https URLs
        spinner.text = `Downloading repository data: ${repo.name}`;
        const { data } = await axios.get(repo.url);
        repoData = data;
      }
      
      // Check for paw in different repository structures
      let pawInfo = null;
      
      spinner.text = `Looking for package "${pawName}" in ${repo.name}...`;
      
      // First check the traditional 'paws' object structure
      if (repoData.paws && repoData.paws[pawName]) {
        pawInfo = repoData.paws[pawName];
        pawInfo.downloadUrl = pawInfo.downloadUrl || pawInfo.downloadURL;
      } 
      // Then check the 'apps' array structure used in the user's repo.json
      else if (repoData.apps) {
        const appEntry = repoData.apps.find(app => app.pawName === pawName);
        if (appEntry) {
          pawInfo = appEntry;
          pawInfo.downloadUrl = appEntry.downloadURL || appEntry.downloadUrl;
        }
      }
      
      if (pawInfo && pawInfo.downloadUrl) {
        found = true; // Mark as found before attempting install
        pawVersion = pawInfo.version; // Store the version
        
        spinner.text = `Found package "${pawName}" - starting download...`;
        
        try {
          let pawData;
          
          // Handle file:// protocol for paw downloads
          if (pawInfo.downloadUrl.startsWith('file://')) {
            spinner.text = 'Reading package from local file...';
            const filePath = pawInfo.downloadUrl.replace('file://', '');
            if (!fs.existsSync(filePath)) {
              throw new Error(`Paw file not found: ${filePath}`);
            }
            pawData = fs.readFileSync(filePath);
          } else {
            // Use axios for http/https URLs
            const hostname = new URL(pawInfo.downloadUrl).hostname;
            spinner.text = `Downloading package from ${hostname}...`;
            
            let lastProgressUpdate = Date.now();
            const response = await axios.get(pawInfo.downloadUrl, {
              responseType: 'arraybuffer',
              onDownloadProgress: (progressEvent) => {
                // Only update every 100ms to allow spinner to animate
                const now = Date.now();
                if (now - lastProgressUpdate > 100) {
                  if (progressEvent.total) {
                    const progress = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                    spinner.text = `Downloading package: ${progress}%`;
                  }
                  lastProgressUpdate = now;
                }
              }
            });
            pawData = response.data;
          }
          
          spinner.text = 'Creating temporary workspace...';
          const tempDir = path.join(os.tmpdir(), `pawkit-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`);
          const tempFile = path.join(tempDir, 'paw.paw');
          
          try {
            // Create temp directory
            fs.ensureDirSync(tempDir);
            
            // Write the downloaded paw data directly to the temp file
            fs.writeFileSync(tempFile, pawData);
            
            // If we have metadata from the repository, add it to the existing paw file
            if (pawInfo.version || pawInfo.metadata) {
              spinner.text = 'Adding metadata to package...';
              
              // Create metadata object combining repo info and any existing metadata
              const metadata = {
                name: pawName,
                version: pawInfo.version || '0.0.0',
                ...(pawInfo.metadata || {}),
                ...pawInfo
              };
              
              // Remove download URL from metadata as it's not needed
              delete metadata.downloadUrl;
              delete metadata.downloadURL;
              
              // Check if the paw file is a valid zip
              if (isValidZipFile(tempFile)) {
                // Create a metadata directory
                const metadataDir = path.join(tempDir, 'metadata');
                fs.ensureDirSync(metadataDir);
                
                // Write metadata to temp location
                fs.writeJsonSync(path.join(metadataDir, 'data.json'), metadata);
                
                // Open the existing paw file as a zip
                const zip = new AdmZip(tempFile);
                
                // Add the metadata to the existing zip
                zip.addLocalFolder(metadataDir, 'metadata');
                
                // Write back to the temp file
                zip.writeZip(tempFile);
                
                // Clean up metadata directory
                fs.removeSync(metadataDir);
              } else {
                spinner.warn('Downloaded file is not a valid zip archive, metadata will be provided separately');
                // Just make the metadata available to the installation function
                // through a side channel since we can't modify the file
                process.env.PAWKIT_TEMP_METADATA = JSON.stringify(metadata);
              }
            }
            
            spinner.text = 'Installing package...';
            
            try {
              // Install directly from the temp file
              await installFromFile(tempFile, spinner);
            } catch (installError) {
              // If the error is about existing files, we want to preserve that message
              if (installError.message.includes('files already exist')) {
                throw installError;
              }
              // For other errors, wrap them to avoid tempFile references
              throw new Error(`Failed to install paw: ${installError.message}`);
            } finally {
              // Clean up the side channel metadata if we set it
              if (process.env.PAWKIT_TEMP_METADATA) {
                delete process.env.PAWKIT_TEMP_METADATA;
              }
            }
            
            return; // Successfully installed, exit function
          } finally {
            // Cleanup temp files
            try {
              if (fs.existsSync(tempDir)) {
                fs.removeSync(tempDir);
                debugLog(chalk.yellow(`🧹 Cleaned up temporary directory: ${tempDir}`));
              }
            } catch (cleanupError) {
              debugLog(chalk.yellow(`⚠️ Failed to cleanup temporary files: ${cleanupError.message}`));
            }
          }
        } catch (error) {
          // If this is an existing files error, preserve it
          if (error.message.includes('files already exist')) {
            throw error;
          }
          // Otherwise wrap it
          throw new Error(`Failed to process paw: ${error.message}`);
        }
      }
    } catch (error) {
      lastError = error;
      if (found) {
        // If paw was found but installation failed, throw immediately
        throw error;
      }
      spinner.warn(`Failed to fetch from repo ${repo.name}: ${error.message}`);
    }
  }
  
  if (!found) {
    throw new Error(`Paw ${pawName} not found in any repository`);
  } else if (lastError) {
    // This case shouldn't be reached due to immediate throws above, but keep as fallback
    throw lastError;
  }
}

async function remove(pawName) {
  const spinner = ora('Preparing to remove paw...').start();
  
  try {
    console.log(chalk.blue(`\n🗑️  Removing paw: ${pawName}`));
    const paws = fs.readJsonSync(PAWS_FILE);
    const pawInfo = paws.installed[pawName];
    
    if (!pawInfo) {
      throw new Error(`Paw ${pawName} is not installed`);
    }
    
    spinner.stop();
    console.log(chalk.blue(`📋 Found ${pawInfo.files.length} files to remove`));
    
    // Get paw metadata
    const metadata = pawInfo.metadata || {};
    const deletePaths = metadata.deletePaths || [];
    
    // Track undeleted items for later display
    const failedDeletions = [];
    
    // Helper function to identify app bundles
    const isAppBundlePath = (path) => {
      return path.includes('.app/Contents/');
    };
    
    // Helper function to get the root .app path
    const getAppBundleRoot = (filePath) => {
      const appIndex = filePath.indexOf('.app');
      if (appIndex !== -1) {
        return filePath.substring(0, appIndex + 4);
      }
      return null;
    };
    
    // Find all app bundles first
    const appBundles = new Set();
    
    for (const file of pawInfo.files) {
      if (isAppBundlePath(file)) {
        const appRoot = getAppBundleRoot(file);
        if (appRoot) {
          appBundles.add(appRoot);
        }
      }
    }
    
    // Process app bundles first - remove them as complete units
    if (appBundles.size > 0) {
      console.log(chalk.blue(`📱 Found ${appBundles.size} application bundles to remove`));
      
      for (const appPath of appBundles) {
        console.log(chalk.yellow(`🗑️  Removing app bundle: ${appPath}`));
        try {
          if (fs.existsSync(appPath)) {
            // On macOS, use native rm command which handles .app bundles better
            if (process.platform === 'darwin') {
              try {
                // Use rm -rf to ensure complete removal including the .app directory itself
                const rmCommand = `rm -rf "${appPath}"`;
                child_process.execSync(rmCommand, { stdio: 'pipe' });
                console.log(chalk.green(`✓ Removed app bundle: ${appPath}`));
              } catch (rmError) {
                console.log(chalk.yellow(`⚠️ Native removal failed, falling back to fs.removeSync: ${rmError.message}`));
                fs.removeSync(appPath);
                console.log(chalk.green(`✓ Removed app bundle: ${appPath}`));
              }
            } else {
              // For other platforms, use standard fs.removeSync
              fs.removeSync(appPath);
              console.log(chalk.green(`✓ Removed app bundle: ${appPath}`));
            }
          } else {
            console.log(chalk.yellow(`⚠️ App bundle not found: ${appPath}`));
          }
        } catch (error) {
          console.log(chalk.red(`✗ Failed to remove app bundle: ${appPath}`));
          console.log(chalk.red(`  Error: ${error.message}`));
          failedDeletions.push({ path: appPath, error: error.message });
        }
      }
    }
    
    // Process special delete paths if specified in metadata
    if (deletePaths.length > 0) {
      console.log(chalk.blue(`📋 Found ${deletePaths.length} additional paths to remove from metadata`));
      
      for (const deletePath of deletePaths) {
        // Handle ~ notation in paths (represents user's home directory)
        let resolvedPath = deletePath.replace(/^~\//, `${os.homedir()}/`);
        
        // Handle special @paths
        for (const [key, value] of Object.entries(specialPaths)) {
          if (resolvedPath.includes(key)) {
            resolvedPath = resolvedPath.replace(key, value);
          }
        }
        
        console.log(chalk.yellow(`🗑️  Removing additional path: ${resolvedPath}`));
        
        // Check if the path exists before attempting to remove it
        if (!fs.existsSync(resolvedPath)) {
          console.log(chalk.yellow(`⚠️ Path does not exist, skipping: ${resolvedPath}`));
          continue;
        }
        
        // Get path information
        let isDirectory = false;
        try {
          const stats = fs.statSync(resolvedPath);
          isDirectory = stats.isDirectory();
        } catch (error) {
          console.log(chalk.yellow(`⚠️ Unable to stat path, proceeding anyway: ${error.message}`));
        }
        
        try {
          // For Application Support directories, try the more powerful command
          if (resolvedPath.includes('Application Support')) {
            console.log(chalk.gray(`📂 Processing Application Support directory: ${resolvedPath}`));
            
            try {
              // Check if directory still exists after trying to remove it
              let directoryStillExists = fs.existsSync(resolvedPath);
              if (!directoryStillExists) {
                console.log(chalk.green(`✓ Successfully removed Application Support directory: ${resolvedPath}`));
                continue; // Already removed, move to next path
              }
              
              console.log(chalk.yellow(`⚠️ Directory still exists, trying more aggressive deletion: ${resolvedPath}`));
              
              // Try to find any running processes that might be using this directory
              const findRunningProcesses = spawnSync('lsof', [resolvedPath], { stdio: 'pipe' });
              const runningProcesses = findRunningProcesses.stdout ? findRunningProcesses.stdout.toString() : '';
              
              if (runningProcesses.trim() !== '') {
                console.log(chalk.yellow(`⚠️ Found processes using the directory:`));
                console.log(chalk.gray(runningProcesses));
              }
              
              // Apply a more forceful command
              const command = `sudo sh -c 'chflags -R 0 "${resolvedPath}" && chmod -R 777 "${resolvedPath}" && rm -Rf "${resolvedPath}"'`;
              console.log(chalk.gray(`Executing: ${command}`));
              
              const result = spawnSync('sh', ['-c', command], { stdio: 'inherit' });
              
              // Very important: Verify if the directory has actually been removed
              directoryStillExists = fs.existsSync(resolvedPath);
              
              if (directoryStillExists) {
                console.log(chalk.red(`❌ Failed to remove directory: ${resolvedPath}`));
                
                // Get directory contents to help diagnose the issue
                try {
                  const dirContents = fs.readdirSync(resolvedPath);
                  console.log(chalk.yellow(`⚠️ Directory contains ${dirContents.length} items`));
                  
                  // Add each file in the directory to failedDeletions
                  dirContents.forEach(item => {
                    const itemPath = path.join(resolvedPath, item);
                    failedDeletions.push({
                      path: itemPath,
                      error: 'Could not be removed with elevated permissions'
                    });
                  });
                  
                  // Also add the directory itself
                  failedDeletions.push({
                    path: resolvedPath,
                    error: 'Could not be removed with elevated permissions'
                  });
                } catch (err) {
                  console.log(chalk.red(`❌ Could not read directory contents: ${err.message}`));
                  failedDeletions.push({
                    path: resolvedPath,
                    error: `Could not be removed: ${err.message}`
                  });
                }
              } else {
                console.log(chalk.green(`✓ Successfully removed: ${resolvedPath}`));
              }
            } catch (err) {
              console.log(chalk.red(`❌ Error during removal: ${err.message}`));
              failedDeletions.push({
                path: resolvedPath,
                error: err.message
              });
            }
          } else {
            // Standard file/directory removal
            try {
              await fs.promises.rm(resolvedPath, { recursive: true, force: true });
              
              // Verify if the file/directory was actually removed
              const stillExists = fs.existsSync(resolvedPath);
              if (stillExists) {
                console.log(chalk.red(`❌ Failed to remove: ${resolvedPath}`));
                failedDeletions.push({
                  path: resolvedPath,
                  error: 'Could not be removed with standard permissions'
                });
              } else {
                console.log(chalk.green(`✓ Removed: ${resolvedPath}`));
              }
            } catch (err) {
              console.log(chalk.red(`❌ Failed to remove: ${resolvedPath}`));
              console.log(chalk.red(`   Error: ${err.message}`));
              failedDeletions.push({
                path: resolvedPath,
                error: err.message
              });
            }
          }
        } catch (error) {
          console.log(chalk.red(`✗ Failed to remove: ${resolvedPath}`));
          console.log(chalk.red(`  Error: ${error.message}`));
          failedDeletions.push({
            path: resolvedPath,
            error: error.message
          });
        }
      }
    }
    
    // Remove all remaining individual files
    for (const file of pawInfo.files) {
      // Skip files that are part of app bundles as we've already removed the entire bundles
      if (Array.from(appBundles).some(appPath => file.startsWith(appPath))) {
        continue;
      }
      
      console.log(chalk.yellow(`🗑️  Removing: ${file}`));
      try {
        fs.removeSync(file);
        console.log(chalk.green(`✓ Removed: ${file}`));
      } catch (error) {
        console.log(chalk.red(`✗ Failed to remove: ${file}`));
        console.log(chalk.red(`  Error: ${error.message}`));
        failedDeletions.push({ path: file, error: error.message });
      }
    }
    
    // Remove paw from metadata
    console.log(chalk.blue('💾 Updating paw metadata...'));
    delete paws.installed[pawName];
    fs.writeJsonSync(PAWS_FILE, paws);
    console.log(chalk.green('✓ Updated paw metadata'));
    
    // Display summary of failed deletions if any
    if (failedDeletions.length > 0) {
      console.log(chalk.yellow(`\n⚠️ ${failedDeletions.length} items could not be deleted:`));
      console.log(chalk.yellow(`📋 Manual deletion required for the following items:`));
      
      // Group by directory to make it easier to understand
      const pathsByDir = {};
      failedDeletions.forEach(item => {
        const dir = path.dirname(item.path);
        if (!pathsByDir[dir]) {
          pathsByDir[dir] = [];
        }
        pathsByDir[dir].push(item.path);
      });
      
      // Print grouped by directory
      for (const [dir, paths] of Object.entries(pathsByDir)) {
        console.log(chalk.yellow(`\n📁 Directory: ${dir}`));
        paths.forEach(filePath => {
          console.log(chalk.gray(`   - ${path.basename(filePath)}`));
        });
      }
      
      // Show commands to manually remove items
      console.log(chalk.yellow(`\n📝 Commands to manually remove these items:`));
      if (process.platform === 'darwin') {
        console.log(chalk.gray(`   # To remove all items at once:`));
        
        // Create groups of no more than 5 paths per command to avoid command line length issues
        const pathGroups = [];
        let currentGroup = [];
        
        failedDeletions.forEach(item => {
          if (currentGroup.length >= 5) {
            pathGroups.push([...currentGroup]);
            currentGroup = [];
          }
          currentGroup.push(item.path);
        });
        
        if (currentGroup.length > 0) {
          pathGroups.push(currentGroup);
        }
        
        pathGroups.forEach((group, index) => {
          const quotedPaths = group.map(p => `"${p}"`).join(' ');
          console.log(chalk.gray(`   sudo sh -c 'chflags -R 0 ${quotedPaths} && chmod -R 777 ${quotedPaths} && rm -Rf ${quotedPaths}'`));
        });
        
        console.log(chalk.gray(`\n   # Or for individual directories/files:`));
        const uniqueDirs = Object.keys(pathsByDir);
        for (let i = 0; i < Math.min(uniqueDirs.length, 3); i++) {
          const dir = uniqueDirs[i];
          console.log(chalk.gray(`   sudo rm -rf "${dir}"`));
        }
        if (uniqueDirs.length > 3) {
          console.log(chalk.gray(`   # ... and ${uniqueDirs.length - 3} more directories`));
        }
      } else {
        // For non-macOS platforms
        console.log(chalk.gray(`   # You may need administrator privileges to remove these items`));
        console.log(chalk.gray(`   # Example commands for removal:`));
        for (let i = 0; i < Math.min(failedDeletions.length, 5); i++) {
          console.log(chalk.gray(`   rm -rf "${failedDeletions[i].path}"`));
        }
        if (failedDeletions.length > 5) {
          console.log(chalk.gray(`   # ... and ${failedDeletions.length - 5} more items`));
        }
      }
    }
  } catch (error) {
    spinner.stop();
    console.error(chalk.red(`\n✗ Failed to remove paw: ${error.message}`));
    throw error;
  }
}

async function addRepo(url) {
  const spinner = ora('Adding repository...').start();
  
  try {
    let repoData;

    // Handle file:// protocol separately
    if (url.startsWith('file://')) {
      // Convert file URL to local path
      const filePath = url.replace('file://', '');
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`Repository file not found: ${filePath}`);
      }
      
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        repoData = JSON.parse(fileContent);
      } catch (error) {
        throw new Error(`Failed to parse repository file: ${error.message}`);
      }
    } else {
      // Use axios for http/https URLs
      const { data } = await axios.get(url);
      repoData = data;
    }
    
    const repos = fs.readJsonSync(REPOS_FILE);
    
    if (repos.repositories.some(r => r.url === url)) {
      throw new Error('Repository already exists');
    }
    
    // Extract repository name from data or use a default
    const repoName = repoData.repositoryName || repoData.name || 'Unknown Repository';
    
    repos.repositories.push({
      name: repoName,
      url: url,
      addedDate: new Date().toISOString()
    });
    
    fs.writeJsonSync(REPOS_FILE, repos);
    spinner.succeed(`Repository "${repoName}" added successfully!`);
  } catch (error) {
    spinner.fail('Failed to add repository');
    throw error;
  }
}

async function removeRepo(name) {
  const spinner = ora('Removing repository...').start();
  
  try {
    const repos = fs.readJsonSync(REPOS_FILE);
    const index = repos.repositories.findIndex(r => r.name === name);
    
    if (index === -1) {
      throw new Error(`Repository ${name} not found`);
    }
    
    repos.repositories.splice(index, 1);
    fs.writeJsonSync(REPOS_FILE, repos);
    spinner.succeed('Repository removed successfully!');
  } catch (error) {
    spinner.fail('Failed to remove repository');
    throw error;
  }
}

async function update(target) {
  console.log(chalk.blue(`🔄 Starting update for: ${target}`));
  const spinner = ora('Updating...').start();
  
  try {
    if (target === 'all') {
      spinner.stop();
      await updateAllRepos();
      const pawsUpdated = await updateAllPaws();
      if (pawsUpdated) {
        console.log(chalk.green('✅ Update completed successfully! Paws were updated.'));
      } else {
        console.log(chalk.green('✅ All paws are already up to date.'));
      }
    } else {
      const paws = fs.readJsonSync(PAWS_FILE);
      if (paws.installed[target]) {
        spinner.stop();
        const wasUpdated = await updatePaw(target);
        if (wasUpdated) {
          console.log(chalk.green(`✅ Paw ${target} was updated successfully!`));
        } else {
          console.log(chalk.green(`✅ Paw ${target} is already at the latest version.`));
        }
      } else {
        await updateRepo(target);
        spinner.succeed(`Repository ${target} was updated successfully!`);
      }
    }
  } catch (error) {
    spinner.fail(`Update failed: ${error.message}`);
    console.error(chalk.red(error.stack));
  }
}

function cleanAndMapPath(entryPath) {
  try {
    // Debug path transformation
    let cleanPath = entryPath.replace(/\\/g, '/');
    
    // Remove leading slashes, dots and Mac __MACOSX entries
    cleanPath = cleanPath.replace(/^[\/\.]+|__MACOSX\//g, '');
    
    debugLog(chalk.gray('Path transformation:'));
    debugLog(chalk.gray(`  Original: ${entryPath}`));
    debugLog(chalk.gray(`  Initial clean: ${cleanPath}`));
    
    // Extract the @* part from the path, even if it's nested
    let atPrefixMatch = cleanPath.match(/(@\w+)\//);
    if (atPrefixMatch) {
      const atPrefix = atPrefixMatch[1];
      const atPrefixIndex = cleanPath.indexOf(atPrefix);
      let mappedPath = cleanPath.substring(atPrefixIndex);
      
      debugLog(chalk.gray(`  Found @* prefix: ${atPrefix}`));
      debugLog(chalk.gray(`  Extracted path with prefix: ${mappedPath}`));
      
      // Check for @all/ prefix
      if (mappedPath.startsWith('@all/')) {
        mappedPath = mappedPath.substring('@all/'.length);
        debugLog(chalk.gray(`  After removing @all/: ${mappedPath}`));
      }
      
      // Print all available special paths for debugging
      debugLog(chalk.gray(`  Available special paths: ${Object.keys(specialPaths).join(', ')}`));
      
      // Apply special path mappings
      for (const [placeholder, replacement] of Object.entries(specialPaths)) {
        debugLog(chalk.gray(`  Checking if path starts with ${placeholder}/`));
        if (mappedPath.startsWith(`${placeholder}/`)) {
          mappedPath = path.join(replacement, mappedPath.substring(placeholder.length + 1));
          debugLog(chalk.green(`  Final mapped: ${mappedPath}`));
          return mappedPath;
        }
      }
    }
    
    // For metadata files, store them in .pawkit/pluginmetadata instead of Documents folder
    if (cleanPath.includes('metadata/')) {
      const metadataIndex = cleanPath.indexOf('metadata/');
      const metadataPath = cleanPath.substring(metadataIndex);
      
      // Create pluginmetadata directory inside CONFIG_DIR (~/.pawkit)
      const metadataDir = path.join(CONFIG_DIR, 'pluginmetadata');
      fs.ensureDirSync(metadataDir);
      
      const mappedPath = path.join(metadataDir, metadataPath.replace('metadata/', ''));
      debugLog(chalk.green(`  Final mapped (metadata): ${mappedPath}`));
      return mappedPath;
    }
    
    // CHANGED: No longer allow custom relative paths
    // Return null for any path that doesn't have a valid @* prefix
    debugLog(chalk.red(`  Path rejected: ${cleanPath} - does not use a valid @* prefix`));
    return null;
  } catch (error) {
    console.error(chalk.red(`Error mapping path: ${error.message}`));
    return null; // Changed from returning original path to returning null
  }
}

async function updateAllRepos() {
  const repos = fs.readJsonSync(REPOS_FILE);
  for (const repo of repos.repositories) {
    await updateRepo(repo.name);
  }
}

async function updateAllPaws() {
  const paws = fs.readJsonSync(PAWS_FILE);
  
  // Add a counter for completed paws
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  // Track if any updates were actually performed
  let anyUpdatesPerformed = false;
  
  console.log(chalk.blue(`Found ${Object.keys(paws.installed).length} installed paws to check for updates`));
  
  for (const pawName of Object.keys(paws.installed)) {
    try {
      console.log(chalk.blue(`\nChecking paw: ${pawName}`));
      const wasUpdated = await updatePaw(pawName);
      
      if (wasUpdated) {
        updatedCount++;
        anyUpdatesPerformed = true;
      } else {
        skippedCount++;
      }
    } catch (error) {
      errorCount++;
      console.error(chalk.red(`Error updating ${pawName}: ${error.message}`));
    }
  }
  
  console.log(chalk.green(`\n✅ Update check completed. Updated: ${updatedCount}, Already up-to-date: ${skippedCount}, Errors: ${errorCount}`));
  return anyUpdatesPerformed;
}

async function updateRepo(repoName) {
  const repos = fs.readJsonSync(REPOS_FILE);
  const repo = repos.repositories.find(r => r.name === repoName);
  
  if (!repo) {
    throw new Error(`Repository ${repoName} not found`);
  }
  
  try {
    // Handle file:// protocol separately
    if (repo.url.startsWith('file://')) {
      const filePath = repo.url.replace('file://', '');
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`Repository file not found: ${filePath}`);
      }
      
      try {
        // Just check if we can read and parse the file
        const fileContent = fs.readFileSync(filePath, 'utf8');
        JSON.parse(fileContent); // Validate it's valid JSON
        console.log(chalk.blue(`✓ Successfully verified local repository file: ${filePath}`));
      } catch (error) {
        throw new Error(`Failed to parse repository file: ${error.message}`);
      }
    } else {
      // Use axios for http/https URLs
      await axios.get(repo.url);
    }
    
    repo.lastUpdated = new Date().toISOString();
    fs.writeJsonSync(REPOS_FILE, repos);
  } catch (error) {
    throw new Error(`Failed to update repository ${repoName}: ${error.message}`);
  }
}

async function updatePaw(pawName) {
  try {
    const paws = fs.readJsonSync(PAWS_FILE);
    const installedPaw = paws.installed[pawName];
    if (!installedPaw) {
      throw new Error(`Paw ${pawName} is not installed`);
    }

    // Check if the installed version is already the latest
    console.log(chalk.blue('🐾 Checking for updates...'));
    const latestRepoVersion = await getLatestVersionFromRepo(pawName);
    console.log(chalk.blue(`   Paw version: ${installedPaw.version}`));
    console.log(chalk.blue(`   Repository version: ${latestRepoVersion}`));
    
    if (compareVersions(installedPaw.version, latestRepoVersion) >= 0) {
      console.log(chalk.green(`✅ Paw ${pawName} is already at the latest version (${installedPaw.version}).`));
      return false;
    }

    // Show update confirmation prompt
    console.log(chalk.blue(`\n🐾 Update available for ${pawName}:`));
    console.log(chalk.blue(`   Current version: ${installedPaw.version}`));
    console.log(chalk.blue(`   Repository version: ${latestRepoVersion}`));
    
    // Use readline for the prompt
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    process.stdout.write(chalk.yellow('\nProceed with update? (y/n): '));
    
    const answer = await new Promise(resolve => {
      process.stdin.once('data', (data) => {
        const input = data.toString().trim().toLowerCase();
        rl.close();
        resolve(input);
      });
    });

    if (answer !== 'y' && answer !== 'yes') {
      console.log(chalk.yellow('\nUpdate cancelled by user'));
      return false;
    }

    // Show update progress
    console.log(chalk.blue(`\n🔄 Starting update process...`));

    // Uninstall the paw first
    console.log(chalk.blue(`🔄 Uninstalling paw: ${pawName}`));
    await remove(pawName);

    // Reinstall the paw
    console.log(chalk.blue(`🔄 Reinstalling paw: ${pawName}`));
    await installFromRepo(pawName);

    // Get the new version from the installed paw metadata
    const updatedPaws = fs.readJsonSync(PAWS_FILE);
    const updatedPaw = updatedPaws.installed[pawName];
    console.log(chalk.green(`✅ Successfully updated paw: ${pawName} to version ${updatedPaw.version}`));
    return true;
  } catch (error) {
    console.error(chalk.red(`❌ Error updating paw ${pawName}: ${error.message}`));
    throw error;
  }
}

async function getLatestVersionFromRepo(pawName) {
  const repos = fs.readJsonSync(REPOS_FILE);
  let latestVersion = '0.0.0';
  let found = false;

  for (const repo of repos.repositories) {
    try {
      let repoData;
      if (repo.url.startsWith('file://')) {
        const filePath = repo.url.replace('file://', '');
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const fileContent = fs.readFileSync(filePath, 'utf8');
        repoData = JSON.parse(fileContent);
      } else {
        const { data } = await axios.get(repo.url, { timeout: 10000 }); // Add timeout
        repoData = data;
      }

      let pawInfo = null;
      if (repoData.paws && repoData.paws[pawName]) {
        pawInfo = repoData.paws[pawName];
      } else if (repoData.apps) {
        pawInfo = repoData.apps.find(app => app.pawName === pawName);
      }

      if (pawInfo && pawInfo.version) {
        found = true;
        // Compare versions and keep the highest one if found in multiple repos
        if (compareVersions(pawInfo.version, latestVersion) > 0) {
          latestVersion = pawInfo.version;
        }
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to fetch version from repo ${repo.name}: ${error.message}`));
    }
  }

  if (!found) {
    throw new Error(`Could not find latest version for paw ${pawName} in any repository`);
  }
  return latestVersion;
}

// Helper function to compare version strings
function compareVersions(version1, version2) {
  const parts1 = version1.split('.').map(Number);
  const parts2 = version2.split('.').map(Number);
  
  // Pad arrays to same length
  while (parts1.length < parts2.length) parts1.push(0);
  while (parts2.length < parts1.length) parts2.push(0);
  
  // Compare each part
  for (let i = 0; i < parts1.length; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  
  return 0; // Versions are equal
}

async function config(action, key, value) {
  // Load current config
  const configData = fs.readJsonSync(CONFIG_FILE);
  
  if (action === 'get') {
    if (key) {
      if (key in configData) {
        console.log(chalk.blue(`${key}: ${configData[key]}`));
      } else {
        console.log(chalk.yellow(`Config key "${key}" not found`));
      }
    } else {
      // Show all config
      console.log(chalk.blue('Current configuration:'));
      Object.entries(configData).forEach(([k, v]) => {
        console.log(chalk.blue(`${k}: ${v}`));
      });
    }
  } else if (action === 'set') {
    if (!key) {
      throw new Error('Key required for setting configuration');
    }
    
    if (!(key in configData)) {
      console.log(chalk.yellow(`Creating new config key: ${key}`));
    }
    
    // Handle boolean values from string input
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    
    configData[key] = value;
    fs.writeJsonSync(CONFIG_FILE, configData);
    console.log(chalk.green(`Set ${key} to ${value}`));
  } else {
    console.log(chalk.blue('Usage:'));
    console.log(chalk.blue('  config get [key]    - Get config value or all config'));
    console.log(chalk.blue('  config set key value - Set config value'));
  }
}

async function listInstalledApps() {
  try {
    const paws = fs.readJsonSync(PAWS_FILE);
    const installedPaws = paws.installed || {};
    
    if (Object.keys(installedPaws).length === 0) {
      console.log(chalk.yellow('No paws are currently installed.'));
      return;
    }
    
    console.log(chalk.blue('\n🐾 Installed Paws:'));
    console.log(chalk.gray('─'.repeat(60)));
    
    for (const [pawName, pawInfo] of Object.entries(installedPaws)) {
      console.log(chalk.green(`📄 ${pawName}`));
      
      // Display paw metadata if available
      if (pawInfo.metadata) {
        if (pawInfo.metadata.version) {
          console.log(chalk.blue(`   Version: ${pawInfo.metadata.version}`));
        }
        if (pawInfo.metadata.description) {
          console.log(chalk.blue(`   Description: ${pawInfo.metadata.description}`));
        }
        if (pawInfo.metadata.author) {
          console.log(chalk.blue(`   Author: ${pawInfo.metadata.author}`));
        }
      }
      
      // Display installation info
      if (pawInfo.installedDate) {
        console.log(chalk.blue(`   Installed: ${new Date(pawInfo.installedDate).toLocaleString()}`));
      }
      
      // Display file count
      if (pawInfo.files && pawInfo.files.length) {
        console.log(chalk.blue(`   Files: ${pawInfo.files.length}`));
      }
      
      console.log(chalk.gray('─'.repeat(60)));
    }
  } catch (error) {
    console.error(chalk.red(`Error listing installed paws: ${error.message}`));
    throw error;
  }
}

async function getPawInfo(pawName) {
  try {
    const paws = fs.readJsonSync(PAWS_FILE);
    const installedPaws = paws.installed || {};
    
    // If no paw name provided, list available paws
    if (!pawName) {
      console.log(chalk.yellow('No paw specified. Available paws:'));
      
      if (Object.keys(installedPaws).length === 0) {
        console.log(chalk.yellow('No paws are currently installed.'));
        return;
      }
      
      Object.keys(installedPaws).forEach(name => {
        console.log(chalk.green(`- ${name}`));
      });
      console.log(chalk.blue('\nUse "pawkit info <pawname>" to get detailed information.'));
      return;
    }
    
    // Check if the paw exists
    if (!installedPaws[pawName]) {
      console.log(chalk.red(`Paw '${pawName}' is not installed.`));
      return;
    }
    
    const pawInfo = installedPaws[pawName];
    
    // Display detailed paw information
    console.log(chalk.blue('\n🐾 Paw Information:'));
    console.log(chalk.green(`Paw Name: ${pawName}`));
    console.log(chalk.gray('─'.repeat(60)));
    
    // Display metadata
    if (pawInfo.metadata) {
      console.log(chalk.blue('📋 Metadata:'));
      
      if (pawInfo.metadata.version) {
        console.log(chalk.blue(`   Version: ${pawInfo.metadata.version}`));
      }
      
      if (pawInfo.metadata.description) {
        console.log(chalk.blue(`   Description: ${pawInfo.metadata.description}`));
      }
      
      if (pawInfo.metadata.author) {
        console.log(chalk.blue(`   Author: ${pawInfo.metadata.author}`));
      }
      
      // Display additional metadata if available
      const excludeKeys = ['version', 'description', 'author', 'files', 'deletePaths'];
      const additionalKeys = Object.keys(pawInfo.metadata).filter(key => !excludeKeys.includes(key));
      
      if (additionalKeys.length > 0) {
        console.log(chalk.blue('   Additional Metadata:'));
        additionalKeys.forEach(key => {
          const value = pawInfo.metadata[key];
          const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
          console.log(chalk.blue(`      ${key}: ${displayValue}`));
        });
      }
    }
    
    // Display installation info
    console.log(chalk.blue('\n📅 Installation Info:'));
    if (pawInfo.installedDate) {
      console.log(chalk.blue(`   Installed: ${new Date(pawInfo.installedDate).toLocaleString()}`));
    }
    
    // Display source information
    if (pawInfo.source) {
      console.log(chalk.blue(`   Source: ${pawInfo.source}`));
    }
    
    // Display files
    if (pawInfo.files && pawInfo.files.length) {
      console.log(chalk.blue(`\n📁 Installed Files (${pawInfo.files.length}):`));
      pawInfo.files.forEach(file => {
        // Check if file exists
        const fileExists = fs.existsSync(file);
        if (fileExists) {
          console.log(chalk.green(`   ✓ ${file}`));
        } else {
          console.log(chalk.red(`   ✗ ${file} (missing)`));
        }
      });
    } else {
      console.log(chalk.yellow('\nNo files information available.'));
    }
    
    console.log(chalk.gray('─'.repeat(60)));
  } catch (error) {
    console.error(chalk.red(`Error getting paw info: ${error.message}`));
    throw error;
  }
}

// Add this new function for handling app bundle installation
async function installAppBundle(appPath, bundleInfo) {
  try {
    // Find common source directory - ideally we want to find the root of the .app
    let sourceAppDir = null;
    let bestPathDepth = Number.MAX_SAFE_INTEGER;
    
    for (const sourceDir of bundleInfo.sourceDirs) {
      // Try to find a source directory that ends with .app/Contents
      if (sourceDir.includes('.app/Contents')) {
        const appRoot = sourceDir.substring(0, sourceDir.indexOf('.app/') + 4);
        const pathDepth = appRoot.split('/').length;
        
        // Choose the shallowest path (closest to the root of the extraction)
        if (pathDepth < bestPathDepth) {
          sourceAppDir = appRoot;
          bestPathDepth = pathDepth;
        }
      }
    }
    
    // If we found a source .app directory, use that
    if (sourceAppDir && fs.existsSync(sourceAppDir)) {
      // At this point, we know ditto is available (we checked before calling this function)
      console.log(chalk.blue(`🐾 Using ditto to copy entire app bundle from ${sourceAppDir} to ${appPath}`));
      
      // Use ditto with flags to preserve all metadata, structure, and symlinks
      const cmd = `ditto --preserve-hfs-compression --noqtn --keepparent "${sourceAppDir}" "${appPath}"`;
      
      debugLog(chalk.blue(`Executing: ${cmd}`));
      child_process.execSync(cmd);
      console.log(chalk.green(`✓ Installed application bundle: ${appPath}`));
      
      // Make sure the main executable is executable
      const mainExecutable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
      if (fs.existsSync(mainExecutable)) {
        fs.chmodSync(mainExecutable, 0o755);
        debugLog(chalk.blue(`🔑 Ensured executable permission for ${mainExecutable}`));
      }
      
      console.log(chalk.green(`✨ App bundle installed successfully with all attributes and symlinks preserved`));
      return true;
    } else {
      // We need to install the app bundle file by file
      console.log(chalk.yellow(`⚠️ Could not find .app bundle root directory. Cannot proceed with bundle installation.`));
      return false;
    }
  } catch (error) {
    console.log(chalk.red(`❌ Failed to install app bundle ${appPath}: ${error.message}`));
    debugLog(chalk.red(error.stack));
    return false;
  }
}

module.exports = {
  install,
  remove,
  addRepo,
  removeRepo,
  update,
  config,
  listInstalledApps,
  getPawInfo
};