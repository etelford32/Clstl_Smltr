# 🎨 Celestial Object Creator Studio

An interactive tool to design and explore custom stars, black holes, nebula, planets, and moons!

## ✨ Features

### Object Types

1. **⭐ Stars**
   - Adjustable temperature (2000K - 15000K)
   - Custom colors
   - Glow intensity and corona size
   - Solar wind/flare activity
   - Pulsing effects

2. **🕳️ Black Holes**
   - Event horizon rendering
   - Accretion disk with orbital particles
   - Gravitational lensing effects
   - Custom disk colors
   - Adjustable gravity strength

3. **🌌 Nebula**
   - Flowing particle clouds
   - Adjustable density and spread
   - Swirling motion effects
   - Custom colors and gradients
   - Up to 1000 particles

4. **🌍 Planets**
   - Procedural surface features
   - Optional atmosphere glow
   - Optional ring system
   - Rotation animation
   - Custom colors

5. **🌙 Moons**
   - Same features as planets
   - Smaller default size
   - Can orbit planets (manually positioned)

6. **💧 Blobs**
   - Amorphous celestial objects
   - Custom shapes and behaviors

## 🎮 How to Use

### Running the Studio

```bash
# Run locally
python celestial_studio.py

# Or with Pygbag (web version)
pip install pygbag
pygbag celestial_studio.py
```

### Controls

#### Canvas Interaction
- **Click** on canvas to move the current object
- Objects appear in real-time as you adjust parameters

#### Right Panel Controls

**Object Type Selection:**
- Click buttons to switch between Star, Black Hole, Nebula, Planet, Moon, Blob

**Common Parameters:**
- **Size**: Adjust object radius (20-200 pixels)
- **Color R/G/B**: Control object color (0-255 for each channel)
- **Pulse Speed**: Animation speed (0-5)

**Type-Specific Parameters:**

*Stars:*
- **Temperature**: 2000K (red) to 15000K (blue)
- **Glow**: Intensity of corona effect
- **Corona**: Size of outer glow
- **Flares**: Solar wind particle emission rate

*Black Holes:*
- **Disk R/G/B**: Accretion disk color
- **Gravity**: Visual gravity strength
- **Accretion Disk**: Toggle on/off

*Nebula:*
- **Particles**: Number of particles (100-1000)
- **Density**: Particle concentration
- **Spread**: Cloud size
- **Flow**: Movement speed

*Planets/Moons:*
- **Rotation**: Spin speed
- **Atmosphere**: Toggle atmospheric glow
- **Rings**: Toggle ring system

#### Action Buttons

- **+ Add to Scene**: Add current object to the scene
- **Clear Scene**: Remove all objects from scene
- **Save Scene**: Export scene to `celestial_scene.json`

## 🎨 Creative Tips

### Creating Realistic Objects

**Sun-like Star:**
```
Type: Star
Size: 100
Temperature: 5778
Color: Yellow (255, 220, 100)
Glow: 1.5
Flares: 0.8
```

**Red Dwarf:**
```
Type: Star
Size: 60
Temperature: 3000
Color: Red-Orange (255, 100, 50)
Glow: 1.0
Flares: 0.3
```

**Blue Giant:**
```
Type: Star
Size: 150
Temperature: 12000
Color: Blue-White (150, 180, 255)
Glow: 2.0
Flares: 1.5
```

**Black Hole with Accretion Disk:**
```
Type: Black Hole
Size: 80
Accretion Disk: ON
Disk Color: Orange-Red (255, 100, 50)
Gravity: 2.0
```

**Colorful Nebula:**
```
Type: Nebula
Size: 120
Particles: 800
Density: 1.5
Spread: 250
Flow: 1.0
Color: Purple-Pink (200, 100, 255)
```

**Earth-like Planet:**
```
Type: Planet
Size: 70
Color: Blue-Green (100, 150, 255)
Atmosphere: ON
Rings: OFF
Rotation: 1.0
```

**Saturn-like Planet:**
```
Type: Planet
Size: 120
Color: Tan (200, 180, 140)
Atmosphere: ON
Rings: ON
Rotation: 2.0
```

### Building Scenes

**Solar System:**
1. Create a yellow star (Sun) in center
2. Add planets at different distances
3. Vary planet sizes and colors
4. Add moons near some planets
5. Add a nebula background

**Binary Star System:**
1. Create two stars of different colors
2. Position them near each other
3. Add planets orbiting around both
4. Set different temperatures for contrast

**Black Hole Scene:**
1. Create a black hole in center
2. Add a nearby star being consumed
3. Create a colorful accretion disk
4. Add nebula for dramatic background

**Nebula Field:**
1. Create multiple nebula clouds
2. Use different colors (red, purple, blue)
3. Vary sizes and densities
4. Add small stars scattered throughout

## 💾 Saving and Loading

### Save Your Scene

Click "Save Scene" to export to `celestial_scene.json`

Example saved file:
```json
[
  {
    "object_type": "star",
    "name": "My Star",
    "size": 100,
    "x": 400,
    "y": 300,
    "color_r": 255,
    "color_g": 220,
    "color_b": 100,
    "temperature": 5778,
    "glow_intensity": 1.5,
    "flare_activity": 0.8
  },
  {
    "object_type": "planet",
    "name": "My Planet",
    "size": 60,
    "x": 600,
    "y": 300,
    "color_r": 100,
    "color_g": 150,
    "color_b": 255,
    "has_atmosphere": true,
    "has_rings": false
  }
]
```

### Load a Scene (Future Feature)

Coming soon: Load saved scenes back into the studio!

## 🎯 Examples to Try

### Example 1: Supernova Remnant
1. Large nebula (spread: 350, particles: 900)
2. Purple/pink color
3. Central white star (small, high temp)
4. High flow rate for expansion effect

### Example 2: Accretion Disk Feeding
1. Black hole (size: 100)
2. Small red star nearby (temperature: 3000)
3. Enable accretion disk
4. Position star close to black hole
5. Add particle effects

### Example 3: Planetary System
1. Central yellow star
2. 4-5 planets at various distances
3. Gas giant with rings (size: 120)
4. Rocky planets closer in (size: 50-70)
5. Moons orbiting gas giant

## 🔧 Technical Details

### Performance

- **Particles**: Each object can have hundreds of particles
- **Optimization**: Objects are updated at 60 FPS
- **Limits**: Keep total objects under 20 for best performance

### Color Science

Temperature-to-color mapping:
- 2000-3500K: Red dwarfs (orange-red)
- 3500-5000K: K-type stars (orange)
- 5000-6000K: G-type stars (yellow, like Sun)
- 6000-10000K: A/F-type stars (white)
- 10000-15000K: B-type stars (blue-white)

### Physics

- **Particles**: Simple physics with velocity and position
- **Orbital motion**: Accretion disk particles orbit black hole
- **Nebula flow**: Particles swirl and flow realistically
- **Solar wind**: Particles emit radially from star surface

## 🚀 Export and Share

### Screenshots

1. Create your scene
2. Use system screenshot tool
3. Share on social media!

### Video Capture

Use OBS or similar to record:
1. Set canvas size to desired resolution
2. Start recording
3. Adjust parameters in real-time
4. Create time-lapse of object creation

### Web Deployment

Deploy your studio online:
```bash
# Build for web
pygbag --build celestial_studio.py

# Deploy to GitHub Pages
# See DEPLOYMENT.md for details
```

## 🎓 Learning Resources

This studio demonstrates:
- **Particle systems**: Thousands of particles with physics
- **Color gradients**: Procedural color generation
- **UI design**: Sliders, buttons, toggles
- **Object-oriented design**: Inheritance and polymorphism
- **Async programming**: Web-compatible event loops
- **Data serialization**: JSON save/load

## 🐛 Troubleshooting

**Objects not appearing:**
- Check they're positioned on canvas (left side)
- Adjust size slider
- Try different colors

**Slow performance:**
- Reduce particle counts (nebula, stars)
- Clear scene and start fresh
- Lower flare activity on stars

**Can't see particles:**
- Increase flare activity (stars)
- Increase density (nebula)
- Adjust color for contrast

## 💡 Future Features

Coming soon:
- [ ] Load saved scenes
- [ ] Animation timeline
- [ ] Orbital mechanics
- [ ] Galaxy spiral arms
- [ ] Comet tails
- [ ] Supernova explosions
- [ ] Export as animated GIF
- [ ] Preset templates
- [ ] Undo/Redo
- [ ] Object layers

## 🎉 Have Fun!

The universe is yours to create! Experiment with different combinations, discover unique effects, and share your cosmic creations!

---

**Pro Tip:** Try creating impossible objects that don't exist in nature - purple stars, green black holes, massive nebula clouds. Let your imagination run wild! 🌟
