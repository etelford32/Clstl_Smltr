# Vercel Auto-Deploy Setup

This guide shows you how to set up automatic deployments to Vercel whenever you push to GitHub.

## Quick Setup (5 minutes)

### Step 1: Connect GitHub to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"**
3. Import `etelford32/Clstl_Smltr` repository
4. Configure:
   - **Framework Preset**: Other
   - **Root Directory**: `./` (leave as default)
   - **Build Command**: (leave empty - it's a static site)
   - **Output Directory**: `./` (leave as default)
5. Click **"Deploy"**

### Step 2: Enjoy Auto-Deployment! 🎉

That's it! Now every time you push to your repository:
- Vercel automatically deploys the latest version
- You get a live URL: `https://your-project.vercel.app`
- Preview deployments for pull requests
- Production deployments for main branch

## What's Already Configured

✅ `vercel.json` - Root configuration with WASM headers
✅ `.vercelignore` - Excludes build artifacts and Python cache
✅ CORS headers for WASM files
✅ Static file serving optimized

## Your Live URLs

After deployment, you'll have:

- **Production**: `https://clstl-smltr.vercel.app` (or your custom domain)
- **Previews**: `https://clstl-smltr-<git-branch>.vercel.app`

## Testing Locally Before Deploy

```bash
# Install Vercel CLI (optional)
npm i -g vercel

# Run local development server
vercel dev

# Or use Python's simple server
python3 -m http.server 8000
```

## Custom Domain (Optional)

1. Go to your Vercel project dashboard
2. Click **Settings** → **Domains**
3. Add your custom domain
4. Follow DNS configuration instructions

## Environment Variables (If Needed)

If you add any secrets or API keys later:

1. Go to **Settings** → **Environment Variables**
2. Add variables for Production/Preview/Development
3. Reference them in your code

## Deployment Branches

- `main` → Production (`https://clstl-smltr.vercel.app`)
- All other branches → Preview deployments
- Pull requests → Automatic preview deployments

## Current Project Structure

```
/
├── index.html          # Main homepage (auto-served)
├── rust/
│   └── www/
│       └── placeholder.html  # Rust WASM (coming soon)
├── vercel.json         # Deployment config
└── .vercelignore       # Files to exclude
```

## Troubleshooting

**"Build failed"**
- This is a static site, no build needed
- Make sure Build Command is empty in settings

**"WASM files not loading"**
- Check browser console for CORS errors
- Headers are already configured in vercel.json

**"404 on some pages"**
- All paths are relative and should work
- Check file paths in index.html

## Next Steps

1. **Deploy now**: Follow Step 1 above
2. **Share your URL**: Get it from Vercel dashboard
3. **Set up custom domain**: (optional)
4. **Enable analytics**: Vercel Analytics (free tier available)

## Support

- Vercel Docs: https://vercel.com/docs
- This repo's issues: https://github.com/etelford32/Clstl_Smltr/issues

---

**Ready to deploy?** Just push this commit and connect your repo to Vercel! 🚀
