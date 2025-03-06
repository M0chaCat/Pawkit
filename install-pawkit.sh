#!/bin/bash

# PawKit Installer Script
# This script downloads and installs PawKit on your system

# Text formatting
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
NC="\033[0m" # No Color

echo -e "${BOLD}${BLUE}PawKit Installer${NC}"
echo "This script will download and install PawKit on your system."
echo

# Check for required dependencies
echo -e "${BOLD}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo "Please install Node.js before continuing: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d 'v' -f 2)
NODE_MAJOR=$(echo $NODE_VERSION | cut -d '.' -f 1)

if [ "$NODE_MAJOR" -lt 14 ]; then
    echo -e "${RED}Error: PawKit requires Node.js version 14 or higher.${NC}"
    echo "Current version: $NODE_VERSION"
    echo "Please update Node.js before continuing: https://nodejs.org/"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed.${NC}"
    echo "Please install npm before continuing."
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git is not installed.${NC}"
    echo "Git is required to download PawKit. Please install Git before continuing."
    echo "Visit https://git-scm.com/downloads for installation instructions."
    exit 1
fi

echo -e "${GREEN}✓ All dependencies are satisfied.${NC}"
echo

# Create temporary directory
TEMP_DIR=$(mktemp -d)
echo -e "${BOLD}Creating temporary directory at:${NC} $TEMP_DIR"

# Clean up on exit or error
cleanup() {
    echo -e "${BOLD}Cleaning up temporary files...${NC}"
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

# Function to handle errors
handle_error() {
    echo -e "${RED}An error occurred during installation.${NC}"
    echo "Please check the error message above and try again."
    exit 1
}

trap handle_error ERR

# Clone PawKit repository
echo -e "${BOLD}Downloading PawKit...${NC}"
echo "Cloning repository with Git..."
git clone https://github.com/M0chaCat/Pawkit.git "$TEMP_DIR/pawkit" || handle_error
echo -e "${GREEN}✓ Download complete.${NC}"
echo

# Install dependencies
echo -e "${BOLD}Installing dependencies...${NC}"
cd "$TEMP_DIR/pawkit"
npm install || handle_error
echo -e "${GREEN}✓ Dependencies installed.${NC}"
echo

# Build the project if needed
if [ -f "package.json" ] && grep -q '"build"' "package.json"; then
    echo -e "${BOLD}Building project...${NC}"
    npm run build || handle_error
    echo -e "${GREEN}✓ Build complete.${NC}"
    echo
fi

# Create installation directory
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

# Install PawKit globally
echo -e "${BOLD}Installing PawKit...${NC}"

# Create executable script
PAWKIT_BIN="$INSTALL_DIR/pawkit"
echo '#!/usr/bin/env node' > "$PAWKIT_BIN"
echo 'require("'"$HOME/.pawkit/app/src/cli.js"'");' >> "$PAWKIT_BIN"
chmod +x "$PAWKIT_BIN"

# Copy application files
mkdir -p "$HOME/.pawkit/app"
cp -R "$TEMP_DIR/pawkit/"* "$HOME/.pawkit/app/"

echo -e "${GREEN}✓ PawKit installed successfully!${NC}"
echo

# Copy PawKit.paw to Downloads folder
if [ -f "$TEMP_DIR/pawkit/PawKit.paw" ]; then
    echo -e "${BOLD}Copying PawKit.paw to Downloads folder...${NC}"
    cp "$TEMP_DIR/pawkit/PawKit.paw" "$HOME/Downloads/"
    echo -e "${GREEN}✓ PawKit.paw has been copied to your Downloads folder.${NC}"
    echo
    echo -e "${BOLD}Try PawKit with the test file:${NC}"
    echo "  pawkit install ~/Downloads/PawKit.paw    - Test installation with the PawKit test file"
    echo
else
    echo -e "${YELLOW}Warning: PawKit.paw file not found in the repository.${NC}"
    echo "The test file could not be copied to your Downloads folder."
    echo
fi

# Add test repository from URL
echo -e "${BOLD}Adding test repository...${NC}"
"$PAWKIT_BIN" addrepo https://rawcdn.githack.com/M0chaCat/Pawkit/refs/heads/main/testrepo.json repo || {
    echo -e "${YELLOW}Warning: Could not add test repository. The repository appears to be private or unavailable.${NC}"
    echo -e "${YELLOW}You can add repositories manually later when they become available.${NC}"
}
# Continue with installation whether or not the repository was added
echo -e "${BOLD}Repository setup complete.${NC}"
echo
echo -e "${BOLD}When repositories are available, you can use:${NC}"
echo "  pawkit install [package-name]    - Install a package from a repository"
echo

# Check if $INSTALL_DIR is in PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo -e "${YELLOW}Note: $INSTALL_DIR is not in your PATH.${NC}"
    echo "To add it, run these commands:"
    echo
    echo "  echo 'export PATH=\"\$PATH:$INSTALL_DIR\"' >> ~/.bashrc"
    echo "  source ~/.bashrc"
    echo
    if [ -f "$HOME/.zshrc" ]; then
        echo "If you're using zsh, run:"
        echo "  echo 'export PATH=\"\$PATH:$INSTALL_DIR\"' >> ~/.zshrc"
        echo "  source ~/.zshrc"
        echo
    fi
fi

# Provide usage instructions
echo -e "${BOLD}${GREEN}PawKit Installation Complete!${NC}"
echo 
echo -e "${BOLD}Usage:${NC}"
echo "  pawkit install <package>         - Install a package"
echo "  pawkit fi <package>              - Force install a package (skip confirmation)"
echo "  pawkit delete <package>          - Uninstall a package"
echo "  pawkit update <package>          - Update a package"
echo
echo -e "${BOLD}Test File:${NC}"
echo "  You can install the test file to verify your installation is working properly:"
echo "  pawkit install PawKit"
echo "  To remove the test file, run:"
echo "  pawkit delete PawKit" 
echo
echo -e "${BOLD}For more information:${NC}"
echo "  pawkit --help"
echo

exit 0 