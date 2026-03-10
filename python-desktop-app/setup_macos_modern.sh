#!/bin/bash
#
# Modern macOS Setup Script for JIRAForge TimeTracker
# Handles Python 3.12+ installation and dependency management for macOS 26.3
#
# Usage: ./setup_macos_modern.sh [OPTIONS]
#

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly PURPLE='\033[0;35m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly NC='\033[0m'

# Constants
readonly MIN_PYTHON_VERSION="3.12.0"
readonly MIN_MACOS_VERSION="14.0"
readonly REQUIRED_TOOLS=("git" "brew" "xcode-select")

# Configuration
INSTALL_PYTHON=false
INSTALL_HOMEBREW=false
SKIP_XCODE=false
FORCE_REINSTALL=false
VERBOSE=false

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

log_header() {
    echo -e "\n${PURPLE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${PURPLE}║${WHITE}    JIRAForge TimeTracker - Modern macOS Setup       ${PURPLE}║${NC}"
    echo -e "${PURPLE}║${CYAN}             For macOS 26.3 Tahoe + Python 3.12+       ${PURPLE}║${NC}"
    echo -e "${PURPLE}╚══════════════════════════════════════════════════════╝${NC}\n"
}

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✅${NC} $1"; }
log_warning() { echo -e "${YELLOW}⚠️${NC} $1"; }
log_error() { echo -e "${RED}❌${NC} $1" >&2; }
log_step() { echo -e "\n${WHITE}📍 $1${NC}"; }

show_help() {
    log_header
    cat << 'EOF'
USAGE:
    ./setup_macos_modern.sh [OPTIONS]

OPTIONS:
    --install-python     Install Python 3.12+ via Homebrew
    --install-homebrew   Install Homebrew if not present
    --skip-xcode        Skip Xcode Command Line Tools check
    --force             Force reinstall all dependencies
    --verbose           Enable verbose output
    --help              Show this help

WHAT THIS SCRIPT DOES:
    • Validates macOS version compatibility
    • Checks/installs Xcode Command Line Tools
    • Checks/installs Homebrew package manager
    • Installs Python 3.12+ if needed
    • Sets up virtual environment
    • Installs modern dependencies
    • Validates the setup

REQUIREMENTS:
    • macOS 14.0 or later (optimized for 26.3 Tahoe)
    • Internet connection
    • Administrator privileges (for system installs)

EOF
}

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

check_macos_compatibility() {
    log_step "Checking macOS compatibility"
    
    local macos_version
    macos_version=$(sw_vers -productVersion)
    local major minor
    IFS='.' read -r major minor <<< "$macos_version"
    
    if (( major < 14 )); then
        log_error "macOS $MIN_MACOS_VERSION or later required. Found: $macos_version"
        log_error "Please upgrade to macOS 14+ for optimal compatibility"
        exit 1
    fi
    
    log_success "macOS $macos_version detected"
    
    if (( major >= 26 )); then
        log_success "Running on modern macOS Tahoe - fully supported!"
    elif (( major >= 15 )); then
        log_info "Running on macOS $macos_version - compatible with optimizations for 26.3"
    else
        log_warning "Older macOS version detected. Consider upgrading for best experience."
    fi
}

check_architecture() {
    log_step "Checking system architecture"
    
    local arch
    arch=$(uname -m)
    
    case $arch in
        arm64)
            log_success "Apple Silicon (M1/M2/M3/M4) detected - optimal performance"
            ;;
        x86_64)
            log_info "Intel x86_64 detected - compatible"
            ;;
        *)
            log_warning "Unknown architecture: $arch"
            ;;
    esac
}

check_xcode_tools() {
    if [[ "$SKIP_XCODE" == true ]]; then
        log_warning "Skipping Xcode Command Line Tools check"
        return
    fi
    
    log_step "Checking Xcode Command Line Tools"
    
    if xcode-select -p &>/dev/null; then
        local xcode_path
        xcode_path=$(xcode-select -p)
        log_success "Xcode Command Line Tools found at: $xcode_path"
    else
        log_warning "Xcode Command Line Tools not found"
        log_info "Installing Xcode Command Line Tools..."
        
        # Trigger installation
        xcode-select --install
        
        log_info "Please complete the Xcode installation and run this script again"
        exit 1
    fi
}

check_homebrew() {
    log_step "Checking Homebrew package manager"
    
    if command -v brew &>/dev/null; then
        local brew_version
        brew_version=$(brew --version | head -1)
        log_success "Homebrew found: $brew_version"
        
        # Update Homebrew
        log_info "Updating Homebrew..."
        brew update &>/dev/null || log_warning "Homebrew update failed"
    else
        if [[ "$INSTALL_HOMEBREW" == true ]]; then
            log_info "Installing Homebrew..."
            /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
            
            # Add to PATH
            if [[ -f /opt/homebrew/bin/brew ]]; then
                echo 'eval \"$(/opt/homebrew/bin/brew shellenv)\"' >> ~/.zprofile
                eval \"$(/opt/homebrew/bin/brew shellenv)\"
            fi
        else
            log_error "Homebrew not found and --install-homebrew not specified"
            log_info "Install Homebrew: https://brew.sh/"
            exit 1
        fi
    fi
}

check_python() {
    log_step "Checking Python installation"
    
    local python_cmd=""
    local found_version=""
    
    # Check for modern Python versions
    for candidate in python3.12 python3.13 python3.14 python3.15 python3; do
        if command -v \"$candidate\" &>/dev/null; then
            local version
            version=$(\"$candidate\" --version 2>&1 | cut -d' ' -f2)
            
            # Check if version is 3.12+
            if python3 -c \"import sys; exit(0 if sys.version_info >= (3, 12) else 1)\" 2>/dev/null; then
                python_cmd=\"$candidate\"
                found_version=\"$version\"
                break
            fi
        fi
    done
    
    if [[ -n \"$python_cmd\" ]]; then
        log_success \"Modern Python found: $found_version at $(which \"$python_cmd\")\"
        export PYTHON_CMD=\"$python_cmd\"
    else
        if [[ \"$INSTALL_PYTHON\" == true ]]; then
            install_modern_python
        else
            log_error \"Python $MIN_PYTHON_VERSION or later required\"
            log_info \"Use --install-python to install automatically\"
            log_info \"Or install manually: brew install python@3.12\"
            exit 1
        fi
    fi
}

install_modern_python() {
    log_info \"Installing Python 3.12 via Homebrew...\"
    
    # Install Python 3.12
    brew install python@3.12
    
    # Link it
    brew link python@3.12
    
    # Update PATH
    echo 'export PATH=\"/opt/homebrew/opt/python@3.12/bin:$PATH\"' >> ~/.zprofile
    export PATH=\"/opt/homebrew/opt/python@3.12/bin:$PATH\"
    
    # Verify installation
    if python3.12 --version &>/dev/null; then
        local version
        version=$(python3.12 --version | cut -d' ' -f2)
        log_success \"Python 3.12 installed successfully: $version\"
        export PYTHON_CMD=\"python3.12\"
    else
        log_error \"Python 3.12 installation failed\"
        exit 1
    fi
}

# ============================================================================
# ENVIRONMENT SETUP
# ============================================================================

setup_virtual_environment() {
    log_step \"Setting up Python virtual environment\"
    
    local venv_dir=\"venv_modern_macos\"
    
    if [[ \"$FORCE_REINSTALL\" == true && -d \"$venv_dir\" ]]; then
        log_info \"Removing existing virtual environment\"
        rm -rf \"$venv_dir\"
    fi
    
    if [[ ! -d \"$venv_dir\" ]]; then
        log_info \"Creating new virtual environment with $PYTHON_CMD\"
        \"$PYTHON_CMD\" -m venv \"$venv_dir\"
    fi
    
    # Activate virtual environment
    source \"$venv_dir/bin/activate\"
    
    # Upgrade core tools
    log_info \"Upgrading pip, wheel, and setuptools...\"
    python -m pip install --upgrade pip wheel setuptools
    
    log_success \"Virtual environment ready: $venv_dir\"
}

install_dependencies() {
    log_step \"Installing project dependencies\"
    
    # Check for modern requirements file
    if [[ -f \"requirements-macos-modern.txt\" ]]; then
        log_info \"Installing from requirements-macos-modern.txt\"
        
        if [[ \"$VERBOSE\" == true ]]; then
            pip install -r requirements-macos-modern.txt
        else
            pip install -r requirements-macos-modern.txt -q
        fi
        
        log_success \"Modern dependencies installed\"
    else
        log_error \"Modern requirements file not found: requirements-macos-modern.txt\"
        exit 1
    fi
    
    # Install development dependencies if needed
    if [[ -f \"requirements-dev.txt\" ]]; then
        log_info \"Installing development dependencies...\"
        pip install -r requirements-dev.txt -q
    fi
}

# ============================================================================
# VALIDATION AND TESTING
# ============================================================================

validate_setup() {
    log_step \"Validating installation\"
    
    # Test compatibility layer
    log_info \"Testing compatibility layer...\"
    python -c \"
import sys
from macos_compatibility import create_compatibility_report

print('Testing modern macOS compatibility...')
try:
    report = create_compatibility_report()
    print(report)
    print('✅ Compatibility validation passed')
except Exception as e:
    print(f'❌ Compatibility validation failed: {e}')
    sys.exit(1)
\"
    
    if [[ $? -eq 0 ]]; then
        log_success \"Installation validation complete\"
    else
        log_error \"Installation validation failed\"
        exit 1
    fi
}

create_launcher_script() {
    log_step \"Creating launcher script\"
    
    cat > run_timetracker_modern.sh << 'EOF'
#!/bin/bash
#
# Modern TimeTracker Launcher
# Activates virtual environment and starts the application
#

set -e

PROJECT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"
VENV_DIR=\"$PROJECT_DIR/venv_modern_macos\"

if [[ ! -d \"$VENV_DIR\" ]]; then
    echo \"❌ Virtual environment not found: $VENV_DIR\"
    echo \"Run ./setup_macos_modern.sh first\"
    exit 1
fi

echo \"🚀 Starting JIRAForge TimeTracker...\"
echo \"📍 Project: $PROJECT_DIR\"
echo \"🐍 Virtual env: $VENV_DIR\"

# Activate virtual environment
source \"$VENV_DIR/bin/activate\"

# Run the application
python mac_desktop_app.py

EOF
    
    chmod +x run_timetracker_modern.sh
    log_success \"Launcher script created: run_timetracker_modern.sh\"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --install-python)
                INSTALL_PYTHON=true
                shift
                ;;
            --install-homebrew)
                INSTALL_HOMEBREW=true
                shift
                ;;
            --skip-xcode)
                SKIP_XCODE=true
                shift
                ;;
            --force)
                FORCE_REINSTALL=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                log_error \"Unknown option: $1\"
                show_help
                exit 1
                ;;
        esac
    done
}

main() {
    parse_arguments \"$@\"
    
    log_header
    
    log_info \"Setting up JIRAForge TimeTracker for macOS 26.3 Tahoe\"
    log_info \"Target: Python 3.12+ with modern frameworks\"
    
    # System validation
    check_macos_compatibility
    check_architecture
    check_xcode_tools
    check_homebrew
    check_python
    
    # Environment setup
    setup_virtual_environment
    install_dependencies
    
    # Validation and final setup
    validate_setup
    create_launcher_script
    
    # Success summary
    echo
    log_success \"🎉 Setup completed successfully!\"
    echo
    echo -e \"${WHITE}Next steps:${NC}\"
    echo -e \"• Run the app: ${CYAN}./run_timetracker_modern.sh${NC}\"
    echo -e \"• Build the app: ${CYAN}./build_macos_modern.sh${NC}\"
    echo -e \"• Check compatibility: ${CYAN}python -c 'from macos_compatibility import create_compatibility_report; print(create_compatibility_report())'${NC}\"
    echo
    
    log_info \"Virtual environment location: venv_modern_macos\"
    log_info \"To activate manually: source venv_modern_macos/bin/activate\"
    echo
}

# ============================================================================
# SCRIPT ENTRY POINT
# ============================================================================

# Ensure script is run from correct directory
if [[ ! -f \"mac_desktop_app.py\" ]]; then
    log_error \"This script must be run from the python-desktop-app directory\"
    log_error \"Current directory: $(pwd)\"
    exit 1
fi

# Run main function with all arguments
main \"$@\"