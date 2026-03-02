#!/bin/bash
#
# Release Management Script for JIRAForge Time Tracker
# Manages version control and database entries for multi-platform releases
#

set -e

# Configuration
API_BASE_URL="https://forgesync.amzur.com"
SUPABASE_URL="https://jvijitdewbypqbatfboi.supabase.co"
DEFAULT_VERSION="1.0.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

show_help() {
    echo "JIRAForge Time Tracker - Release Management"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  create-release     Create a new release entry"
    echo "  list-releases      List all releases"
    echo "  update-release     Update an existing release"
    echo "  delete-release     Delete a release"
    echo "  get-latest         Get latest version for platform"
    echo ""
    echo "Options:"
    echo "  --version VERSION      Version number (required for create)"
    echo "  --platform PLATFORM   Platform: windows, macos, linux (required)"
    echo "  --file FILE           Path to executable file (for create)"
    echo "  --url URL             Download URL (alternative to --file)"
    echo "  --notes NOTES         Release notes"
    echo "  --mandatory           Mark as mandatory update"
    echo "  --token TOKEN         API authentication token"
    echo "  --help                Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 create-release --version 1.2.0 --platform macos --file TimeTracker-1.2.0-macOS.dmg"
    echo "  $0 get-latest --platform windows"
    echo "  $0 list-releases"
}

# Parse arguments
COMMAND=""
VERSION=""
PLATFORM=""
FILE_PATH=""
DOWNLOAD_URL=""
RELEASE_NOTES=""
MANDATORY=false
AUTH_TOKEN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        create-release|list-releases|update-release|delete-release|get-latest)
            COMMAND="$1"
            shift
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --file)
            FILE_PATH="$2"
            shift 2
            ;;
        --url)
            DOWNLOAD_URL="$2"
            shift 2
            ;;
        --notes)
            RELEASE_NOTES="$2"
            shift 2
            ;;
        --mandatory)
            MANDATORY=true
            shift
            ;;
        --token)
            AUTH_TOKEN="$2"
            shift 2
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Validation
if [[ -z "$COMMAND" ]]; then
    echo -e "${RED}❌ Command is required${NC}"
    show_help
    exit 1
fi

# Get file size and checksum
get_file_info() {
    local file_path="$1"
    
    if [[ ! -f "$file_path" ]]; then
        echo -e "${RED}❌ File not found: $file_path${NC}"
        exit 1
    fi
    
    local size=$(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path" 2>/dev/null)
    local checksum=$(shasum -a 256 "$file_path" | cut -d' ' -f1)
    
    echo "$size:$checksum"
}

# Upload file to Supabase Storage
upload_file() {
    local file_path="$1"
    local platform="$2"
    local version="$3"
    
    echo -e "${BLUE}📤 Uploading $file_path to Supabase Storage...${NC}"
    
    # Extract filename and create storage path
    local filename=$(basename "$file_path")
    local storage_path="desktop-app/${platform}/${version}/${filename}"
    
    # Check if supabase CLI is available
    if command -v supabase &> /dev/null; then
        # Upload using Supabase CLI
        supabase storage upload "$storage_path" "$file_path" --project-ref jvijitdewbypqbatfboi
        
        # Generate public URL
        local public_url="${SUPABASE_URL}/storage/v1/object/public/${storage_path}"
        echo "$public_url"
    else
        echo -e "${YELLOW}⚠️  Supabase CLI not found. Please upload manually.${NC}"
        echo "   Upload path: $storage_path"
        echo "   Then use: $0 create-release --url YOUR_URL ..."
        exit 1
    fi
}

# Create release entry
create_release() {
    if [[ -z "$VERSION" || -z "$PLATFORM" ]]; then
        echo -e "${RED}❌ Version and platform are required${NC}"
        exit 1
    fi
    
    # Validate platform
    case "$PLATFORM" in
        windows|macos|linux) ;;
        *)
            echo -e "${RED}❌ Invalid platform. Use: windows, macos, linux${NC}"
            exit 1
            ;;
    esac
    
    local file_size=""
    local checksum=""
    local upload_url=""
    
    # Handle file upload or URL
    if [[ -n "$FILE_PATH" ]]; then
        # Upload file and get URL
        upload_url=$(upload_file "$FILE_PATH" "$PLATFORM" "$VERSION")
        
        # Get file info
        local file_info=$(get_file_info "$FILE_PATH")
        file_size=$(echo "$file_info" | cut -d':' -f1)
        checksum=$(echo "$file_info" | cut -d':' -f2)
        
    elif [[ -n "$DOWNLOAD_URL" ]]; then
        upload_url="$DOWNLOAD_URL"
        echo -e "${YELLOW}⚠️  Using provided URL. File size and checksum not calculated.${NC}"
    else
        echo -e "${RED}❌ Either --file or --url is required${NC}"
        exit 1
    fi
    
    # Prepare release notes
    if [[ -z "$RELEASE_NOTES" ]]; then
        RELEASE_NOTES="Release version $VERSION for $PLATFORM"
    fi
    
    echo -e "${BLUE}📋 Creating release entry...${NC}"
    echo "   Version: $VERSION"
    echo "   Platform: $PLATFORM"
    echo "   Download URL: $upload_url"
    echo "   File Size: ${file_size:-'N/A'} bytes"
    echo "   Checksum: ${checksum:-'N/A'}"
    echo "   Mandatory: $MANDATORY"
    
    # Create SQL for direct database insertion
    cat > release_${VERSION}_${PLATFORM}.sql << EOF
-- Release entry for $VERSION ($PLATFORM)
INSERT INTO app_releases (
    version,
    platform,
    download_url,
    release_notes,
    is_mandatory,
    file_size_bytes,
    checksum,
    is_latest,
    is_active,
    published_at
) VALUES (
    '$VERSION',
    '$PLATFORM',
    '$upload_url',
    '$RELEASE_NOTES',
    $MANDATORY,
    ${file_size:-'NULL'},
    ${checksum:+"'$checksum'"}${checksum:-'NULL'},
    true,
    true,
    NOW()
);

-- Update previous releases to not be latest
UPDATE app_releases 
SET is_latest = false 
WHERE platform = '$PLATFORM' 
AND version != '$VERSION';
EOF

    echo -e "${GREEN}✅ SQL file created: release_${VERSION}_${PLATFORM}.sql${NC}"
    echo -e "${YELLOW}📝 Execute this SQL in your Supabase dashboard or run:${NC}"
    echo "   psql \$DATABASE_URL -f release_${VERSION}_${PLATFORM}.sql"
    
    # Also create API call equivalent
    cat > release_${VERSION}_${PLATFORM}.json << EOF
{
    "version": "$VERSION",
    "platform": "$PLATFORM",
    "downloadUrl": "$upload_url",
    "releaseNotes": "$RELEASE_NOTES",
    "isMandatory": $MANDATORY,
    "fileSizeBytes": ${file_size:-null},
    "checksum": ${checksum:+"\"$checksum\""}${checksum:-null}
}
EOF

    echo -e "${BLUE}📄 JSON payload created: release_${VERSION}_${PLATFORM}.json${NC}"
    
    if [[ -n "$AUTH_TOKEN" ]]; then
        echo -e "${BLUE}🚀 Creating release via API...${NC}"
        
        local response=$(curl -s -X POST "$API_BASE_URL/api/app-version/releases" \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -H "Content-Type: application/json" \
            -d @release_${VERSION}_${PLATFORM}.json)
        
        echo "API Response: $response"
    fi
}

# List all releases
list_releases() {
    echo -e "${BLUE}📋 Fetching releases...${NC}"
    
    if [[ -n "$PLATFORM" ]]; then
        echo "Platform filter: $PLATFORM"
        local url="$API_BASE_URL/api/app-version/releases?platform=$PLATFORM"
    else
        local url="$API_BASE_URL/api/app-version/releases"
    fi
    
    curl -s "$url" | jq '.' 2>/dev/null || echo -e "${YELLOW}Install jq for better JSON formatting${NC}"
}

# Get latest version for platform
get_latest() {
    if [[ -z "$PLATFORM" ]]; then
        echo -e "${RED}❌ Platform is required${NC}"
        exit 1
    fi
    
    echo -e "${BLUE}🔍 Getting latest version for $PLATFORM...${NC}"
    
    local response=$(curl -s "$API_BASE_URL/api/app-version/latest?platform=$PLATFORM")
    echo "$response" | jq '.' 2>/dev/null || echo "$response"
}

# Main execution
case "$COMMAND" in
    create-release)
        create_release
        ;;
    list-releases)
        list_releases
        ;;
    get-latest)
        get_latest
        ;;
    *)
        echo -e "${RED}❌ Command not implemented yet: $COMMAND${NC}"
        exit 1
        ;;
esac