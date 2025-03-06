# PawKit

PawKit is a streamlined application and package installer framework that simplifies the installation process for developers and users. By leveraging `.Paw` packages (aka Paws), PawKit provides a user-friendly and efficient method for distributing and installing applications.

## Features

- **Simple Installation Process**: PawKit automates the installation of files to their correct locations, reducing manual setup steps.
- **Dynamic Path Mapping**: The framework dynamically maps installation paths, ensuring files are placed in the appropriate directories (e.g., `~/Documents`, `~/Library/Application Support`).
- **Flexible Package Format**: Uses Paws, which are simply renamed `.zip` files containing the necessary application files and metadata.
- **User-Friendly**: Designed to provide a seamless experience for both developers and end-users.

## Installation

### Quick Install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/M0chaCat/Pawkit/main/install-pawkit.sh | bash
```

## Usage

### Installing Paws

```bash
# Install from a local .Paw file
pawkit install path/to/paw.paw

# Install from a repository
pawkit install paw-name

# Install multiple paws at once
pawkit install paw1 paw2 paw3

# Or use just i
pawkit i paw-name
```

### Managing Repositories

```bash
# Add a repository
pawkit addrepo https://example.com/repo.json

# Remove a repository
pawkit removerepo repo-name

# Update repositories and paws
pawkit update all
pawkit update repo-name
pawkit update paw-name
```

### Uninstalling Paws

```bash
# Remove an installed paw
pawkit delete paw-name
# or
pawkit remove paw-name

# Remove multiple paw at once
pawkit delete paw1 paw2 paw3
```

## Paw Format

Paws are structured in this way:

### Full Format (with metadata)

```
MyApp.Paw
├── metadata
│   ├── data.json
└── files
    ├── @documents
    │   └── example.txt
    └── @applicationSupport/MyApp
        └── config.json
```

## Special Path Mappings

PawKit understands special path notations prefixed with `@` to map files to common system locations:

- `@userhome` - Maps to user's home directory
- `@documents` - Maps to user's Documents folder (aliases: `@document`, `@docs`)
- `@desktop` - Maps to user's Desktop
- `@downloads` - Maps to user's Downloads folder
- `@applicationsupport` - Maps to Application Support (alias: `@applicationSupport`)
- `@userapplications` - Maps to the user's /Applications
- `@applications` - Maps to /Applications
- `@library` - Maps to ~/Library
- `@preferences` - Maps to ~/Library/Preferences

## Contributing

We welcome contributions to PawKit! If you have suggestions for improvements or have found bugs, please open an issue or submit a pull request.

## License

MIT 