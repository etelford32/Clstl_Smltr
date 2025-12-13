# Star Simulation Deployment Guide

This guide covers all the ways to deploy and run the star simulation live.

## 🌐 Option 1: Web Deployment (Browser-Based)

The easiest way to share your simulation online using Pygbag (Pygame compiled to WebAssembly).

### Method A: GitHub Pages (Free & Easy)

1. **Enable GitHub Pages** in your repository:
   - Go to Settings → Pages
   - Select source: GitHub Actions
   - The `.github/workflows/deploy.yml` will automatically build and deploy

2. **Manual build** (if you want to test locally first):
   ```bash
   # Install Pygbag
   pip install pygbag

   # Build the web version
   pygbag --build main.py

   # Test locally (opens browser at http://localhost:8000)
   pygbag main.py
   ```

3. **Access your live simulation**:
   - URL: `https://yourusername.github.io/Clstl_Smltr/`
   - Works on any device with a modern browser!

### Method B: Deploy to Netlify/Vercel

1. Build the web version:
   ```bash
   pygbag --build main.py
   ```

2. Deploy the `build/web` folder to:
   - [Netlify](https://www.netlify.com/) (drag & drop)
   - [Vercel](https://vercel.com/)
   - [GitHub Pages](https://pages.github.com/)

## 🐳 Option 2: Docker with VNC (Full 3D Version)

Run the full OpenGL version in a container with remote access via VNC.

### Quick Start

```bash
# Build and run with Docker Compose
docker-compose up -d

# Access via web browser
open http://localhost:8080

# Or use a VNC client
# Connect to: localhost:5900
```

### Manual Docker Commands

```bash
# Build the image
docker build -t star-simulation .

# Run the container
docker run -d -p 5900:5900 --name star-sim star-simulation

# View logs
docker logs -f star-sim

# Stop
docker stop star-sim
```

### Accessing the Simulation

**Option A: Web Browser (easiest)**
- Open `http://localhost:8080` in your browser
- You'll see the simulation running in real-time!

**Option B: VNC Client**
- Install a VNC viewer ([RealVNC](https://www.realvnc.com/), TightVNC, etc.)
- Connect to `localhost:5900`
- No password required (or set one in Dockerfile)

### Deploy Docker to Cloud

#### Deploy to DigitalOcean

```bash
# Create a droplet (Ubuntu 22.04)
# SSH into it and run:

sudo apt-get update
sudo apt-get install -y docker.io docker-compose
git clone https://github.com/yourusername/Clstl_Smltr.git
cd Clstl_Smltr
sudo docker-compose up -d

# Access via: http://YOUR_DROPLET_IP:8080
```

#### Deploy to AWS ECS/Fargate

```bash
# Push to Docker Hub first
docker login
docker tag star-simulation yourusername/star-simulation:latest
docker push yourusername/star-simulation:latest

# Then create an ECS task definition using the image
# Configure port 5900 and 8080 in security groups
```

## 💻 Option 3: Local Installation

### Desktop Version (Full 3D with Shaders)

```bash
# Clone repository
git clone https://github.com/yourusername/Clstl_Smltr.git
cd Clstl_Smltr

# Install dependencies
pip install -r requirements.txt

# Run the 3D version
python star_simulation.py
```

**Requirements:**
- Python 3.7+
- OpenGL 2.1+ compatible GPU
- Display/monitor

### Web Version (2D Simplified)

```bash
# Run the 2D web-compatible version locally
python main.py
```

## 📱 Option 4: Mobile/Tablet Access

### Via Web Browser
- Deploy using Option 1 (Pygbag)
- Access from any mobile browser
- Touch-enabled controls work automatically

### Via Docker VNC
- Use a VNC app on iOS/Android
- Connect to your Docker instance
- Full 3D version runs remotely

## 🚀 Option 5: Cloud Platforms

### Heroku
```bash
# Create a Heroku app
heroku create star-simulation

# Add buildpacks
heroku buildpacks:add heroku/python

# Deploy
git push heroku main
```

### Render.com
1. Create new Web Service
2. Connect your GitHub repo
3. Build command: `pip install -r requirements.txt`
4. Start command: `python star_simulation.py`
5. Add VNC configuration

### Railway.app
1. Click "New Project"
2. Select your GitHub repo
3. Railway auto-detects Dockerfile
4. Set environment variables if needed
5. Deploy!

## 🎬 Option 6: Video/Screenshot Export

Create a video or screenshots to share (no live deployment needed):

```bash
# Install additional dependencies
pip install opencv-python pillow

# Generate screenshots (coming soon - see roadmap)
python export_screenshots.py

# Generate video (coming soon - see roadmap)
python export_video.py
```

## 📊 Comparison Table

| Method | Difficulty | Cost | 3D Graphics | Best For |
|--------|-----------|------|-------------|----------|
| Pygbag Web | ⭐ Easy | Free | 2D Only | Sharing online, mobile |
| Docker VNC | ⭐⭐ Medium | Free-$$$ | Full 3D | Remote access, cloud |
| Local Install | ⭐ Easy | Free | Full 3D | Development, demos |
| Video Export | ⭐⭐ Medium | Free | Full 3D | Social media, YouTube |

## 🔧 Troubleshooting

### Pygbag Build Issues

**Problem:** `pygbag` fails to build
**Solution:**
```bash
# Use specific version
pip install pygbag==0.8.7

# Or install from source
pip install git+https://github.com/pygame-web/pygbag
```

### Docker VNC Black Screen

**Problem:** VNC shows black screen
**Solution:**
```bash
# Check logs
docker logs star-sim

# Restart X server
docker exec star-sim supervisorctl restart xvfb
```

### OpenGL Not Available

**Problem:** "OpenGL not supported" error
**Solution:**
- Update graphics drivers
- Use the 2D version (`main.py`) instead
- Enable OpenGL in virtual machine settings

## 🌟 Recommended Deployment for Different Use Cases

### For Portfolio/Resume
→ **Use Pygbag + GitHub Pages**
- Free, fast, works everywhere
- Direct link to share: `https://yourusername.github.io/Clstl_Smltr/`

### For Demos/Presentations
→ **Use Docker VNC on Cloud Server**
- Full quality 3D graphics
- Accessible from anywhere
- Control via web browser

### For Development
→ **Use Local Installation**
- Fastest iteration
- Full debugging capabilities
- No deployment overhead

### For Social Media
→ **Use Video Export**
- Create high-quality recordings
- Share on YouTube, Twitter, etc.
- No need for users to install anything

## 📚 Additional Resources

- [Pygbag Documentation](https://github.com/pygame-web/pygbag)
- [Docker Documentation](https://docs.docker.com/)
- [noVNC Project](https://novnc.com/)
- [GitHub Pages Guide](https://pages.github.com/)

## 🆘 Need Help?

Open an issue on GitHub: [https://github.com/yourusername/Clstl_Smltr/issues](https://github.com/yourusername/Clstl_Smltr/issues)

---

**Quick Start Summary:**

```bash
# Fastest way to get it live:
pip install pygbag
pygbag main.py
# Opens in browser at http://localhost:8000

# Or with Docker:
docker-compose up
# Opens in browser at http://localhost:8080
```
