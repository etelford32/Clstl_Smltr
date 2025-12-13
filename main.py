#!/usr/bin/env python3
"""
Web-compatible version of the star simulation
Compatible with Pygbag for browser deployment
"""

import asyncio
import pygame
import math
import random
from typing import List

# For web deployment compatibility
try:
    import platform
    PLATFORM = platform.system()
except:
    PLATFORM = "Emscripten"


class Particle:
    """Solar wind particle - simplified for web"""
    def __init__(self, radius: float, x: float = 0, y: float = 0):
        # Start at the edge of the circle (2D projection)
        angle = random.uniform(0, 2 * math.pi)

        self.x = x + radius * math.cos(angle)
        self.y = y + radius * math.sin(angle)

        # Velocity pointing outward
        speed = random.uniform(1.5, 3.0)
        self.vx = math.cos(angle) * speed
        self.vy = math.sin(angle) * speed

        # Add some randomness
        self.vx += random.uniform(-0.5, 0.5)
        self.vy += random.uniform(-0.5, 0.5)

        self.life = random.uniform(80, 150)
        self.max_life = self.life
        self.size = random.uniform(2, 4)
        self.hue_offset = random.uniform(-20, 20)

    def update(self):
        """Update particle position"""
        self.x += self.vx
        self.y += self.vy
        self.life -= 1

    def is_alive(self) -> bool:
        """Check if particle is alive"""
        return self.life > 0

    def get_alpha(self) -> float:
        """Get alpha based on remaining life"""
        return (self.life / self.max_life) * 255


class Star2DSimulation:
    """2D Star simulation with particle effects - web compatible"""

    def __init__(self, width: int = 1200, height: int = 800):
        pygame.init()

        self.width = width
        self.height = height
        self.screen = pygame.display.set_mode((width, height))
        pygame.display.set_caption("Star Simulation - Solar Wind")

        self.center_x = width // 2
        self.center_y = height // 2
        self.star_radius = 80

        self.particles: List[Particle] = []
        self.max_particles = 1000

        self.clock = pygame.time.Clock()
        self.time = 0

        # Create star surface with glow
        self.create_star_surface()

        print("Star Simulation Loaded!")
        print("Controls: Click and drag to move the star")
        print("Close window or press ESC to exit")

    def create_star_surface(self):
        """Create pre-rendered star with glow layers"""
        size = int(self.star_radius * 3)
        self.star_surface = pygame.Surface((size, size), pygame.SRCALPHA)
        center = size // 2

        # Outer glow (large, very transparent)
        for i in range(30, 0, -1):
            alpha = int(3 * (30 - i))
            color = (255, 150 + i*2, 50, alpha)
            radius = int(self.star_radius * (1.0 + i * 0.03))
            pygame.draw.circle(self.star_surface, color, (center, center), radius)

        # Middle glow
        for i in range(20, 0, -1):
            alpha = int(8 * (20 - i))
            color = (255, 180 + i*3, 80, alpha)
            radius = int(self.star_radius * (1.0 + i * 0.015))
            pygame.draw.circle(self.star_surface, color, (center, center), radius)

        # Core with gradient
        for i in range(int(self.star_radius), 0, -1):
            t = i / self.star_radius
            # Yellow to white gradient
            r = int(255)
            g = int(220 + 35 * (1 - t))
            b = int(100 + 155 * (1 - t))
            pygame.draw.circle(self.star_surface, (r, g, b), (center, center), i)

    def spawn_particles(self, count: int):
        """Spawn new particles"""
        for _ in range(count):
            if len(self.particles) < self.max_particles:
                self.particles.append(
                    Particle(self.star_radius, self.center_x, self.center_y)
                )

    def update_particles(self):
        """Update all particles"""
        self.particles = [p for p in self.particles if p.is_alive()]
        for particle in self.particles:
            particle.update()

    def draw_star(self):
        """Draw the star with glow"""
        # Calculate pulsing effect
        pulse = math.sin(self.time * 0.05) * 0.1 + 1.0

        # Position to draw (center of surface)
        pos = (
            self.center_x - self.star_surface.get_width() // 2,
            self.center_y - self.star_surface.get_height() // 2
        )

        # Draw with slight scaling for pulse
        if pulse != 1.0:
            size = self.star_surface.get_size()
            new_size = (int(size[0] * pulse), int(size[1] * pulse))
            scaled = pygame.transform.scale(self.star_surface, new_size)
            offset_x = (size[0] - new_size[0]) // 2
            offset_y = (size[1] - new_size[1]) // 2
            self.screen.blit(scaled, (pos[0] + offset_x, pos[1] + offset_y))
        else:
            self.screen.blit(self.star_surface, pos)

    def draw_particles(self):
        """Draw all particles"""
        for particle in self.particles:
            # Calculate distance from center
            dx = particle.x - self.center_x
            dy = particle.y - self.center_y
            dist = math.sqrt(dx*dx + dy*dy)

            alpha = int(particle.get_alpha())
            if alpha <= 0:
                continue

            # Color based on distance
            if dist < self.star_radius * 2:
                # Close: yellow-orange
                color = (255, 200, 100, alpha)
            elif dist < self.star_radius * 3.5:
                # Medium: yellow-white
                color = (255, 240, 180, int(alpha * 0.8))
            else:
                # Far: blue-white
                color = (200, 220, 255, int(alpha * 0.6))

            # Draw particle
            size = int(particle.size)
            surf = pygame.Surface((size*2, size*2), pygame.SRCALPHA)
            pygame.draw.circle(surf, color, (size, size), size)
            self.screen.blit(surf, (int(particle.x - size), int(particle.y - size)))

    def handle_events(self) -> bool:
        """Handle events, return False to quit"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    return False

        # Allow dragging the star
        if pygame.mouse.get_pressed()[0]:
            mouse_x, mouse_y = pygame.mouse.get_pos()
            # Smoothly move toward mouse
            self.center_x += (mouse_x - self.center_x) * 0.1
            self.center_y += (mouse_y - self.center_y) * 0.1

        return True

    async def run(self):
        """Main game loop - async for web compatibility"""
        running = True

        while running:
            # Handle events
            running = self.handle_events()

            # Update
            self.spawn_particles(5)
            self.update_particles()
            self.time += 1

            # Draw
            # Background: dark space
            self.screen.fill((5, 5, 15))

            # Draw stars in background (simple)
            if self.time % 60 == 0:  # Only update occasionally
                for _ in range(3):
                    x = random.randint(0, self.width)
                    y = random.randint(0, self.height)
                    size = random.randint(1, 2)
                    brightness = random.randint(100, 255)
                    pygame.draw.circle(self.screen, (brightness, brightness, brightness), (x, y), size)

            # Draw particles
            self.draw_particles()

            # Draw star on top
            self.draw_star()

            # FPS counter
            fps = int(self.clock.get_fps())
            font = pygame.font.Font(None, 24)
            fps_text = font.render(f"FPS: {fps}", True, (200, 200, 200))
            self.screen.blit(fps_text, (10, 10))

            # Particle count
            particle_text = font.render(f"Particles: {len(self.particles)}", True, (200, 200, 200))
            self.screen.blit(particle_text, (10, 35))

            # Update display
            pygame.display.flip()
            self.clock.tick(60)

            # Yield control for web
            await asyncio.sleep(0)

        pygame.quit()


async def main():
    """Entry point"""
    sim = Star2DSimulation()
    await sim.run()


# Run the simulation
if __name__ == "__main__":
    asyncio.run(main())
