# 3D Star Simulation with Solar Wind

A beautiful 3D star simulation built with Pygame and OpenGL, featuring shader effects and particle-based solar wind animations.

## Features

- **3D Rendered Star**: A fully 3D sphere representing a star with proper lighting and shading
- **GLSL Shaders**: Custom vertex and fragment shaders for realistic star glow and rim lighting effects
- **Solar Wind Particles**: Thousands of particles simulating solar wind emanating from the star's surface
- **Interactive Camera**: Rotate and zoom to view the star from any angle
- **Particle Color Gradients**: Particles change color based on distance from the star (yellow → white → blue)
- **Real-time Rendering**: Smooth 60 FPS animation with optimized OpenGL rendering

## Installation

### Prerequisites

- Python 3.7 or higher
- pip package manager

### Setup

1. Clone or download this repository

2. Install dependencies:
```bash
pip install -r requirements.txt
```

## Running the Simulation

```bash
python star_simulation.py
```

Or make it executable:
```bash
chmod +x star_simulation.py
./star_simulation.py
```

## Controls

- **Arrow Keys**: Rotate the view around the star
  - ← →: Rotate horizontally
  - ↑ ↓: Rotate vertically
- **W**: Zoom in (move camera closer)
- **S**: Zoom out (move camera farther)
- **R**: Reset view to default position
- **ESC**: Exit the simulation

## Technical Details

### Shader Effects

The simulation uses GLSL (OpenGL Shading Language) shaders to create realistic star effects:

- **Vertex Shader**: Calculates surface normals and vertex positions for lighting
- **Fragment Shader**: Implements Fresnel-like rim lighting for the star's corona effect
- **Color Blending**: Dynamic color mixing from yellow core to orange-red glow

### Particle System

- Up to 2,000 simultaneous particles
- Particles spawn at the star's surface and travel outward
- Each particle has:
  - Random initial position on sphere surface
  - Outward velocity with slight randomization
  - Lifetime of 80-150 frames
  - Alpha blending based on remaining life
  - Color that transitions based on distance from star

### Performance Optimizations

- Display lists for static geometry (star sphere)
- Point sprite rendering for particles
- Alpha blending for smooth particle effects
- 60 FPS target with efficient OpenGL calls

## System Requirements

- Graphics card with OpenGL 2.1+ support
- Display capable of 1200x800 resolution (adjustable in code)

## Troubleshooting

### Black screen or no shader effects
- Your GPU may not support GLSL 1.20. The simulation will still run without shaders.
- Update your graphics drivers

### Poor performance
- Reduce `max_particles` in `StarSimulation.__init__()` (line 120)
- Lower the sphere resolution in `create_star_display_list()` (line 205)
- Reduce window size in `main()` function

### Module not found errors
- Ensure all dependencies are installed: `pip install -r requirements.txt`
- Try using a virtual environment

## Customization

You can customize various parameters in `star_simulation.py`:

- `max_particles`: Maximum number of solar wind particles (line 120)
- `star_radius`: Size of the star (line 118)
- `camera_distance`: Initial camera zoom (line 122)
- Particle colors in `draw_particles()` method (lines 284-295)
- Star colors in shader code (lines 162-163)

## License

This project is open source and available for educational purposes.

## Author

Created with Claude Code
