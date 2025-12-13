# 🚀 Quick Start Guide

Get your star simulation live in under 5 minutes!

## The Fastest Way

### Option 1: Browser (Easiest! 🌐)

```bash
pip install pygbag
pygbag main.py
```

**Done!** Opens automatically at `http://localhost:8000`

---

### Option 2: Docker (Full 3D! 🐳)

```bash
docker-compose up
```

**Done!** Opens automatically at `http://localhost:8080`

---

### Option 3: Local (Best Quality! 💻)

```bash
pip install -r requirements.txt
python star_simulation.py
```

**Done!** Runs in a new window with full 3D graphics!

---

## Deploy to the Internet

### GitHub Pages (Free Forever!)

1. **Fork or push this repo to GitHub**

2. **Enable GitHub Pages:**
   - Go to: Settings → Pages
   - Source: Select "GitHub Actions"

3. **Push any commit to trigger deployment**
   ```bash
   git add .
   git commit -m "Deploy to GitHub Pages"
   git push
   ```

4. **Access your live simulation at:**
   ```
   https://YOUR_USERNAME.github.io/Clstl_Smltr/
   ```

**That's it!** Your simulation is now live and accessible worldwide! 🌍

---

## Deploy to Cloud (Docker)

### DigitalOcean ($5/month)

```bash
# Create a droplet (Ubuntu 22.04)
# SSH into it, then:

git clone https://github.com/YOUR_USERNAME/Clstl_Smltr.git
cd Clstl_Smltr
sudo apt install docker.io docker-compose
sudo docker-compose up -d

# Access at: http://YOUR_DROPLET_IP:8080
```

### Railway.app (Free Tier!)

1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `Clstl_Smltr` repository
4. Railway auto-detects Dockerfile and deploys!
5. Access via your Railway URL

---

## Need Help?

- 📖 Full guide: [DEPLOYMENT.md](DEPLOYMENT.md)
- 🐛 Issues: [GitHub Issues](https://github.com/etelford32/Clstl_Smltr/issues)
- 💬 Questions: Open a discussion

---

## What's the Difference?

| Method | Speed | Quality | Best For |
|--------|-------|---------|----------|
| Browser (Pygbag) | ⚡ Fast | 2D Graphics | Sharing online |
| Docker VNC | Medium | Full 3D | Remote access |
| Local | ⚡ Fastest | Full 3D | Development |
| GitHub Pages | Slow (build) | 2D Graphics | Portfolio |

---

## Quick Commands Cheat Sheet

```bash
# Test everything works
python test_simulation.py
python test_web_version.py

# Run locally (3D)
python star_simulation.py

# Run web version (2D)
python main.py

# Build for web
pygbag --build main.py

# Deploy with Docker
docker-compose up -d
docker-compose logs -f        # View logs
docker-compose down           # Stop

# Interactive deployment menu
./deploy.sh
```

---

## 🎉 You're All Set!

Choose any method above and your star simulation will be live in minutes!

For advanced deployment options, see [DEPLOYMENT.md](DEPLOYMENT.md).
