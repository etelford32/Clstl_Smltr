#!/usr/bin/env python3
"""
Simplified star visualization test
Just draws a basic star to verify rendering works
"""

import pygame
import math
import random

def main():
    pygame.init()

    width, height = 1000, 700
    screen = pygame.display.set_mode((width, height))
    pygame.display.set_caption("Simple Star Test - You should see a glowing star!")

    clock = pygame.time.Clock()

    print("=" * 60)
    print("SIMPLE STAR TEST")
    print("=" * 60)
    print("You should see:")
    print("  - Dark space background")
    print("  - Large glowing orange/yellow star in the center")
    print("  - Particles shooting out from the star")
    print("  - FPS counter in top-left")
    print("\nPress ESC to exit")
    print("=" * 60)

    # Star parameters
    star_x = width // 2
    star_y = height // 2
    star_radius = 100

    # Particles
    particles = []

    font = pygame.font.Font(None, 24)
    running = True
    frame = 0

    while running:
        dt = clock.tick(60) / 1000.0

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                running = False

        # Clear screen - dark space
        screen.fill((5, 5, 15))

        # Draw background stars
        if frame % 30 == 0:
            for _ in range(3):
                x = random.randint(0, width)
                y = random.randint(0, height)
                pygame.draw.circle(screen, (200, 200, 200), (x, y), 1)

        # Draw star with glow layers
        # Outer glow
        for i in range(40, 0, -2):
            alpha = max(0, min(255, int(100 * (40 - i) / 40)))
            # Create surface for transparency
            glow_surf = pygame.Surface((star_radius * 4, star_radius * 4), pygame.SRCALPHA)
            radius = star_radius + i * 2
            color = (255, 150 + i, 50, alpha)
            pygame.draw.circle(glow_surf, color, (star_radius * 2, star_radius * 2), radius)
            screen.blit(glow_surf, (star_x - star_radius * 2, star_y - star_radius * 2))

        # Main star body
        for i in range(star_radius, 0, -2):
            t = i / star_radius
            r = 255
            g = int(220 + 35 * (1 - t))
            b = int(100 + 100 * (1 - t))
            pygame.draw.circle(screen, (r, g, b), (star_x, star_y), i)

        # Spawn particles
        if len(particles) < 200:
            for _ in range(5):
                angle = random.uniform(0, 2 * math.pi)
                x = star_x + star_radius * math.cos(angle)
                y = star_y + star_radius * math.sin(angle)
                speed = random.uniform(1, 3)
                vx = math.cos(angle) * speed
                vy = math.sin(angle) * speed
                particles.append({
                    'x': x,
                    'y': y,
                    'vx': vx,
                    'vy': vy,
                    'life': random.uniform(80, 150),
                    'max_life': 150
                })

        # Update and draw particles
        new_particles = []
        for p in particles:
            p['x'] += p['vx']
            p['y'] += p['vy']
            p['life'] -= 1

            if p['life'] > 0:
                new_particles.append(p)

                # Draw particle
                dist = math.sqrt((p['x'] - star_x)**2 + (p['y'] - star_y)**2)
                alpha = int((p['life'] / p['max_life']) * 255)

                if dist < star_radius * 2:
                    color = (255, 200, 100, alpha)
                else:
                    color = (200, 220, 255, int(alpha * 0.6))

                size = 3
                particle_surf = pygame.Surface((size * 2, size * 2), pygame.SRCALPHA)
                pygame.draw.circle(particle_surf, color, (size, size), size)
                screen.blit(particle_surf, (int(p['x'] - size), int(p['y'] - size)))

        particles = new_particles

        # FPS and info
        fps = int(clock.get_fps())
        fps_text = font.render(f"FPS: {fps}", True, (100, 255, 100))
        screen.blit(fps_text, (10, 10))

        particle_text = font.render(f"Particles: {len(particles)}", True, (100, 255, 100))
        screen.blit(particle_text, (10, 40))

        # Instructions
        inst = font.render("Press ESC to exit", True, (200, 200, 200))
        screen.blit(inst, (width - 200, 10))

        # Update display
        pygame.display.flip()

        frame += 1
        if frame % 120 == 0:
            print(f"Frame {frame}, FPS: {fps}, Particles: {len(particles)}")

    pygame.quit()
    print("\n✓ Test completed!")


if __name__ == "__main__":
    main()
