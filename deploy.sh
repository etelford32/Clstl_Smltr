#!/bin/bash
# Quick deployment script for Star Simulation

set -e

echo "🌟 Star Simulation Deployment Tool"
echo "==================================="
echo ""

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Main menu
echo "Choose deployment method:"
echo ""
echo "1. 🌐 Web (Pygbag - runs in browser)"
echo "2. 🐳 Docker (Full 3D with VNC)"
echo "3. 💻 Local (Run on this machine)"
echo "4. 📦 Build for GitHub Pages"
echo "5. 🎬 Test web version locally"
echo ""
read -p "Enter choice [1-5]: " choice

case $choice in
    1)
        echo ""
        echo "📦 Installing Pygbag..."
        pip install pygbag

        echo ""
        echo "🚀 Building web version..."
        pygbag --build main.py

        echo ""
        echo "✅ Build complete!"
        echo "Files are in: ./build/web/"
        echo ""
        echo "To deploy to GitHub Pages:"
        echo "  1. Push to your repository"
        echo "  2. Enable GitHub Actions workflow"
        echo "  3. Your site will be at: https://yourusername.github.io/Clstl_Smltr/"
        ;;

    2)
        if ! command_exists docker; then
            echo "❌ Docker not found. Please install Docker first:"
            echo "   https://docs.docker.com/get-docker/"
            exit 1
        fi

        echo ""
        echo "🐳 Building Docker image..."
        docker-compose build

        echo ""
        echo "🚀 Starting containers..."
        docker-compose up -d

        echo ""
        echo "✅ Docker deployment complete!"
        echo ""
        echo "Access your simulation:"
        echo "  Web VNC: http://localhost:8080"
        echo "  VNC Client: localhost:5900"
        echo ""
        echo "To view logs:"
        echo "  docker-compose logs -f"
        echo ""
        echo "To stop:"
        echo "  docker-compose down"
        ;;

    3)
        echo ""
        echo "📦 Installing dependencies..."
        pip install -r requirements.txt

        echo ""
        echo "🚀 Launching simulation..."
        echo "(Press ESC to exit)"
        echo ""
        sleep 2
        python star_simulation.py
        ;;

    4)
        echo ""
        echo "📦 Installing Pygbag..."
        pip install pygbag

        echo ""
        echo "🏗️  Building for GitHub Pages..."
        pygbag --build main.py

        echo ""
        echo "✅ Build complete!"
        echo ""
        echo "Deployment steps:"
        echo "  1. Commit and push all files"
        echo "  2. Go to GitHub → Settings → Pages"
        echo "  3. Enable 'GitHub Actions' as source"
        echo "  4. The workflow will auto-deploy to:"
        echo "     https://yourusername.github.io/Clstl_Smltr/"
        ;;

    5)
        echo ""
        echo "📦 Installing dependencies..."
        pip install pygame numpy

        echo ""
        echo "🌐 Starting local web server..."
        echo "Opening browser at http://localhost:8000"
        echo ""
        echo "Running web-compatible version..."
        echo "(Press CTRL+C to stop)"
        echo ""

        if command_exists pygbag; then
            pygbag main.py
        else
            echo "Installing pygbag..."
            pip install pygbag
            pygbag main.py
        fi
        ;;

    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac

echo ""
echo "🎉 Done!"
