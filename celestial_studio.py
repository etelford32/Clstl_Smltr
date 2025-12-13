#!/usr/bin/env python3
"""
Celestial Object Creator Studio
Design and explore stars, black holes, nebula, planets, and moons!
"""

import asyncio
import pygame
import math
import random
import json
from typing import List, Dict, Any
from dataclasses import dataclass, asdict
from enum import Enum


class ObjectType(Enum):
    """Types of celestial objects"""
    STAR = "star"
    BLACK_HOLE = "black_hole"
    NEBULA = "nebula"
    PLANET = "planet"
    MOON = "moon"
    BLOB = "blob"


@dataclass
class CelestialParams:
    """Parameters for a celestial object"""
    object_type: str
    name: str
    size: float
    x: float
    y: float

    # Color (RGB 0-255)
    color_r: int = 255
    color_g: int = 200
    color_b: int = 100

    # Star-specific
    temperature: float = 5000  # Kelvin
    glow_intensity: float = 1.0
    corona_size: float = 1.3
    flare_activity: float = 0.5

    # Black hole-specific
    accretion_disk: bool = True
    disk_color_r: int = 255
    disk_color_g: int = 100
    disk_color_b: int = 50
    gravity_strength: float = 1.0

    # Nebula-specific
    particle_count: int = 500
    nebula_density: float = 1.0
    nebula_spread: float = 200
    nebula_flow: float = 0.5

    # Planet-specific
    has_atmosphere: bool = True
    has_rings: bool = False
    rotation_speed: float = 1.0

    # Animation
    pulse_speed: float = 1.0
    rotation: float = 0.0


class Particle:
    """Particle for various effects"""
    def __init__(self, x: float, y: float, vx: float = 0, vy: float = 0):
        self.x = x
        self.y = y
        self.vx = vx
        self.vy = vy
        self.life = random.uniform(80, 150)
        self.max_life = self.life
        self.size = random.uniform(1, 4)
        self.angle = random.uniform(0, 2 * math.pi)

    def update(self):
        self.x += self.vx
        self.y += self.vy
        self.life -= 1

    def is_alive(self):
        return self.life > 0

    def get_alpha(self):
        return (self.life / self.max_life) * 255


class CelestialObject:
    """Base class for celestial objects"""

    def __init__(self, params: CelestialParams):
        self.params = params
        self.particles: List[Particle] = []
        self.time = 0

    def update(self, dt: float):
        """Update object state"""
        self.time += dt
        self.params.rotation += self.params.rotation_speed * dt

        # Update particles
        self.particles = [p for p in self.particles if p.is_alive()]
        for p in self.particles:
            p.update()

    def draw(self, screen: pygame.Surface):
        """Draw the object"""
        pass  # Implemented by subclasses


class Star(CelestialObject):
    """Star with corona and solar wind"""

    def __init__(self, params: CelestialParams):
        super().__init__(params)
        self.create_surface()

    def create_surface(self):
        """Create pre-rendered star surface"""
        size = int(self.params.size * 3)
        self.surface = pygame.Surface((size, size), pygame.SRCALPHA)
        center = size // 2

        # Temperature to color mapping
        temp = self.params.temperature
        if temp < 3500:  # Red dwarf
            core_color = (255, 100, 50)
        elif temp < 5000:  # Orange
            core_color = (255, 180, 80)
        elif temp < 6000:  # Yellow (Sun-like)
            core_color = (255, 220, 100)
        elif temp < 10000:  # White
            core_color = (240, 240, 255)
        else:  # Blue giant
            core_color = (150, 180, 255)

        # Override with custom color if set
        if self.params.color_r != 255 or self.params.color_g != 200:
            core_color = (self.params.color_r, self.params.color_g, self.params.color_b)

        # Outer glow layers
        corona_size = self.params.corona_size
        for i in range(30, 0, -1):
            alpha = int(self.params.glow_intensity * 3 * (30 - i))
            color = (*core_color, alpha)
            radius = int(self.params.size * (corona_size + i * 0.02))
            pygame.draw.circle(self.surface, color, (center, center), radius)

        # Core
        for i in range(int(self.params.size), 0, -1):
            t = i / self.params.size
            r = int(core_color[0])
            g = int(core_color[1] + (255 - core_color[1]) * (1 - t) * 0.3)
            b = int(core_color[2] + (255 - core_color[2]) * (1 - t) * 0.5)
            pygame.draw.circle(self.surface, (r, g, b), (center, center), i)

    def spawn_particles(self):
        """Spawn solar wind particles"""
        if len(self.particles) < 200 * self.params.flare_activity:
            angle = random.uniform(0, 2 * math.pi)
            x = self.params.x + self.params.size * math.cos(angle)
            y = self.params.y + self.params.size * math.sin(angle)
            speed = random.uniform(1, 3) * self.params.flare_activity
            vx = math.cos(angle) * speed
            vy = math.sin(angle) * speed
            self.particles.append(Particle(x, y, vx, vy))

    def update(self, dt: float):
        super().update(dt)
        if self.params.flare_activity > 0:
            self.spawn_particles()

    def draw(self, screen: pygame.Surface):
        # Draw particles first (behind star)
        for p in self.particles:
            dist = math.sqrt((p.x - self.params.x)**2 + (p.y - self.params.y)**2)
            alpha = int(p.get_alpha())

            if dist < self.params.size * 2:
                color = (self.params.color_r, self.params.color_g, self.params.color_b, alpha)
            else:
                color = (200, 200, 255, int(alpha * 0.6))

            size = int(p.size)
            surf = pygame.Surface((size*2, size*2), pygame.SRCALPHA)
            pygame.draw.circle(surf, color, (size, size), size)
            screen.blit(surf, (int(p.x - size), int(p.y - size)))

        # Pulsing effect
        pulse = math.sin(self.time * self.params.pulse_speed * 0.05) * 0.1 + 1.0

        # Draw star
        pos = (
            int(self.params.x - self.surface.get_width() // 2),
            int(self.params.y - self.surface.get_height() // 2)
        )

        if pulse != 1.0:
            size = self.surface.get_size()
            new_size = (int(size[0] * pulse), int(size[1] * pulse))
            scaled = pygame.transform.scale(self.surface, new_size)
            offset_x = (size[0] - new_size[0]) // 2
            offset_y = (size[1] - new_size[1]) // 2
            screen.blit(scaled, (pos[0] + offset_x, pos[1] + offset_y))
        else:
            screen.blit(self.surface, pos)


class BlackHole(CelestialObject):
    """Black hole with accretion disk and gravitational effects"""

    def update(self, dt: float):
        super().update(dt)

        # Spawn accretion disk particles
        if self.params.accretion_disk and len(self.particles) < 300:
            angle = random.uniform(0, 2 * math.pi)
            dist = random.uniform(self.params.size * 1.5, self.params.size * 3)
            x = self.params.x + dist * math.cos(angle)
            y = self.params.y + dist * math.sin(angle)

            # Orbital velocity
            speed = 2.0 / (dist / self.params.size)
            vx = -math.sin(angle) * speed
            vy = math.cos(angle) * speed

            self.particles.append(Particle(x, y, vx, vy))

    def draw(self, screen: pygame.Surface):
        # Draw accretion disk
        if self.params.accretion_disk:
            for p in self.particles:
                dist = math.sqrt((p.x - self.params.x)**2 + (p.y - self.params.y)**2)
                alpha = int(p.get_alpha() * (1 - (dist - self.params.size * 1.5) / (self.params.size * 1.5)))
                alpha = max(0, min(255, alpha))

                # Color gradient based on distance
                t = (dist - self.params.size * 1.5) / (self.params.size * 1.5)
                r = int(self.params.disk_color_r * (1 - t) + 100 * t)
                g = int(self.params.disk_color_g * (1 - t) + 50 * t)
                b = int(self.params.disk_color_b * (1 - t) + 50 * t)

                color = (r, g, b, alpha)
                size = int(p.size * 1.5)
                surf = pygame.Surface((size*2, size*2), pygame.SRCALPHA)
                pygame.draw.circle(surf, color, (size, size), size)
                screen.blit(surf, (int(p.x - size), int(p.y - size)))

        # Draw event horizon (black circle)
        pygame.draw.circle(screen, (0, 0, 0),
                         (int(self.params.x), int(self.params.y)),
                         int(self.params.size))

        # Gravitational lensing effect (rings)
        for i in range(3):
            alpha = 80 - i * 25
            radius = int(self.params.size * (1.2 + i * 0.15))
            pygame.draw.circle(screen, (50, 50, 80, alpha),
                             (int(self.params.x), int(self.params.y)),
                             radius, 2)


class Nebula(CelestialObject):
    """Nebula cloud with flowing particles"""

    def __init__(self, params: CelestialParams):
        super().__init__(params)
        # Initialize nebula particles
        for _ in range(int(params.particle_count * params.nebula_density)):
            angle = random.uniform(0, 2 * math.pi)
            dist = random.gauss(0, params.nebula_spread / 3)
            x = params.x + dist * math.cos(angle)
            y = params.y + dist * math.sin(angle)
            vx = random.uniform(-0.5, 0.5) * params.nebula_flow
            vy = random.uniform(-0.5, 0.5) * params.nebula_flow
            self.particles.append(Particle(x, y, vx, vy))

    def update(self, dt: float):
        super().update(dt)

        # Add flow and turbulence
        for p in self.particles:
            # Flow around center
            dx = p.x - self.params.x
            dy = p.y - self.params.y
            dist = math.sqrt(dx*dx + dy*dy) + 0.1

            # Swirl effect
            p.vx += -dy / dist * 0.01 * self.params.nebula_flow
            p.vy += dx / dist * 0.01 * self.params.nebula_flow

            # Keep particles in bounds
            if dist > self.params.nebula_spread:
                p.vx -= dx / dist * 0.05
                p.vy -= dy / dist * 0.05

        # Respawn particles
        if len(self.particles) < int(self.params.particle_count * self.params.nebula_density):
            angle = random.uniform(0, 2 * math.pi)
            dist = random.gauss(0, self.params.nebula_spread / 3)
            x = self.params.x + dist * math.cos(angle)
            y = self.params.y + dist * math.sin(angle)
            vx = random.uniform(-0.5, 0.5) * self.params.nebula_flow
            vy = random.uniform(-0.5, 0.5) * self.params.nebula_flow
            p = Particle(x, y, vx, vy)
            p.life = 999999  # Nebula particles don't die
            self.particles.append(p)

    def draw(self, screen: pygame.Surface):
        for p in self.particles:
            # Distance from center affects color
            dx = p.x - self.params.x
            dy = p.y - self.params.y
            dist = math.sqrt(dx*dx + dy*dy)
            t = min(1.0, dist / self.params.nebula_spread)

            # Color gradient
            r = int(self.params.color_r * (1 - t * 0.5))
            g = int(self.params.color_g * (1 - t * 0.3))
            b = int(self.params.color_b + (255 - self.params.color_b) * t * 0.5)
            alpha = int(150 * (1 - t))

            color = (r, g, b, alpha)
            size = int(p.size * (2 - t))
            surf = pygame.Surface((size*2, size*2), pygame.SRCALPHA)
            pygame.draw.circle(surf, color, (size, size), size)
            screen.blit(surf, (int(p.x - size), int(p.y - size)))


class Planet(CelestialObject):
    """Planet with optional atmosphere and rings"""

    def __init__(self, params: CelestialParams):
        super().__init__(params)
        self.create_surface()

    def create_surface(self):
        """Create planet surface with features"""
        size = int(self.params.size * 2)
        self.surface = pygame.Surface((size, size), pygame.SRCALPHA)
        center = size // 2

        # Planet body
        pygame.draw.circle(self.surface,
                         (self.params.color_r, self.params.color_g, self.params.color_b),
                         (center, center), int(self.params.size))

        # Add some surface features (darker spots)
        for _ in range(5):
            angle = random.uniform(0, 2 * math.pi)
            dist = random.uniform(0, self.params.size * 0.7)
            fx = center + dist * math.cos(angle)
            fy = center + dist * math.sin(angle)
            feature_size = random.uniform(self.params.size * 0.1, self.params.size * 0.3)
            dark_color = (
                max(0, self.params.color_r - 50),
                max(0, self.params.color_g - 50),
                max(0, self.params.color_b - 50)
            )
            pygame.draw.circle(self.surface, dark_color, (int(fx), int(fy)), int(feature_size))

        # Atmosphere glow
        if self.params.has_atmosphere:
            for i in range(10, 0, -1):
                alpha = i * 5
                atm_color = (
                    self.params.color_r,
                    self.params.color_g,
                    self.params.color_b,
                    alpha
                )
                pygame.draw.circle(self.surface, atm_color, (center, center),
                                 int(self.params.size + i * 2))

    def draw(self, screen: pygame.Surface):
        # Rotation
        rotated = pygame.transform.rotate(self.surface, self.params.rotation)
        rect = rotated.get_rect(center=(int(self.params.x), int(self.params.y)))

        # Draw rings (behind planet)
        if self.params.has_rings:
            ring_color = (200, 180, 150, 150)
            pygame.draw.ellipse(screen, ring_color,
                              (int(self.params.x - self.params.size * 1.8),
                               int(self.params.y - self.params.size * 0.3),
                               int(self.params.size * 3.6),
                               int(self.params.size * 0.6)), 3)

        screen.blit(rotated, rect)


class CelestialStudio:
    """Main studio application"""

    def __init__(self, width: int = 1400, height: int = 900):
        pygame.init()

        self.width = width
        self.height = height
        self.screen = pygame.display.set_mode((width, height))
        pygame.display.set_caption("Celestial Object Creator Studio")

        self.canvas_width = width - 300
        self.canvas_height = height
        self.ui_x = self.canvas_width

        self.current_object: CelestialObject = None
        self.current_params = CelestialParams(
            object_type=ObjectType.STAR.value,
            name="My Star",
            size=80,
            x=self.canvas_width // 2,
            y=self.canvas_height // 2
        )

        self.objects: List[CelestialObject] = []
        self.create_object()

        self.font = pygame.font.Font(None, 24)
        self.small_font = pygame.font.Font(None, 20)
        self.clock = pygame.time.Clock()

        self.dragging = False
        self.selected_slider = None

        self.create_ui()

    def create_ui(self):
        """Create UI controls"""
        self.ui_elements = []
        y = 20

        # Object type selector
        self.ui_elements.append({
            'type': 'label',
            'text': 'Object Type:',
            'y': y
        })
        y += 30

        for obj_type in ObjectType:
            self.ui_elements.append({
                'type': 'button',
                'text': obj_type.value.replace('_', ' ').title(),
                'y': y,
                'value': obj_type.value,
                'action': 'change_type'
            })
            y += 35

        y += 20

        # Common sliders
        sliders = [
            ('Size', 'size', 20, 200),
            ('Color R', 'color_r', 0, 255),
            ('Color G', 'color_g', 0, 255),
            ('Color B', 'color_b', 0, 255),
            ('Pulse Speed', 'pulse_speed', 0, 5),
        ]

        # Type-specific sliders
        obj_type = self.current_params.object_type
        if obj_type == ObjectType.STAR.value:
            sliders.extend([
                ('Temperature', 'temperature', 2000, 15000),
                ('Glow', 'glow_intensity', 0, 3),
                ('Corona', 'corona_size', 1.0, 2.5),
                ('Flares', 'flare_activity', 0, 2),
            ])
        elif obj_type == ObjectType.BLACK_HOLE.value:
            sliders.extend([
                ('Disk R', 'disk_color_r', 0, 255),
                ('Disk G', 'disk_color_g', 0, 255),
                ('Disk B', 'disk_color_b', 0, 255),
                ('Gravity', 'gravity_strength', 0.1, 3),
            ])
        elif obj_type == ObjectType.NEBULA.value:
            sliders.extend([
                ('Particles', 'particle_count', 100, 1000),
                ('Density', 'nebula_density', 0.1, 3),
                ('Spread', 'nebula_spread', 50, 400),
                ('Flow', 'nebula_flow', 0, 3),
            ])
        elif obj_type in [ObjectType.PLANET.value, ObjectType.MOON.value]:
            sliders.extend([
                ('Rotation', 'rotation_speed', 0, 5),
            ])

        for label, attr, min_val, max_val in sliders:
            self.ui_elements.append({
                'type': 'slider',
                'label': label,
                'attr': attr,
                'min': min_val,
                'max': max_val,
                'y': y
            })
            y += 40

        # Toggles
        y += 10
        if obj_type == ObjectType.BLACK_HOLE.value:
            self.ui_elements.append({
                'type': 'toggle',
                'label': 'Accretion Disk',
                'attr': 'accretion_disk',
                'y': y
            })
            y += 35
        elif obj_type in [ObjectType.PLANET.value, ObjectType.MOON.value]:
            self.ui_elements.append({
                'type': 'toggle',
                'label': 'Atmosphere',
                'attr': 'has_atmosphere',
                'y': y
            })
            y += 35
            self.ui_elements.append({
                'type': 'toggle',
                'label': 'Rings',
                'attr': 'has_rings',
                'y': y
            })
            y += 35

        # Action buttons
        y += 20
        self.ui_elements.append({
            'type': 'button',
            'text': '+ Add to Scene',
            'y': y,
            'action': 'add_object'
        })
        y += 40
        self.ui_elements.append({
            'type': 'button',
            'text': 'Clear Scene',
            'y': y,
            'action': 'clear_scene'
        })
        y += 40
        self.ui_elements.append({
            'type': 'button',
            'text': 'Save Scene',
            'y': y,
            'action': 'save_scene'
        })

    def create_object(self):
        """Create celestial object from current params"""
        obj_type = self.current_params.object_type

        if obj_type == ObjectType.STAR.value:
            self.current_object = Star(self.current_params)
        elif obj_type == ObjectType.BLACK_HOLE.value:
            self.current_object = BlackHole(self.current_params)
        elif obj_type == ObjectType.NEBULA.value:
            self.current_object = Nebula(self.current_params)
        elif obj_type in [ObjectType.PLANET.value, ObjectType.MOON.value]:
            self.current_object = Planet(self.current_params)
        else:  # BLOB
            self.current_object = Star(self.current_params)  # Use star as blob for now

    def handle_events(self) -> bool:
        """Handle events"""
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    return False

            if event.type == pygame.MOUSEBUTTONDOWN:
                mx, my = event.pos

                # Check UI clicks
                if mx >= self.ui_x:
                    for elem in self.ui_elements:
                        if elem['type'] == 'button':
                            button_rect = pygame.Rect(self.ui_x + 10, elem['y'], 280, 30)
                            if button_rect.collidepoint(mx, my):
                                self.handle_button(elem)
                        elif elem['type'] == 'toggle':
                            toggle_rect = pygame.Rect(self.ui_x + 10, elem['y'], 20, 20)
                            if toggle_rect.collidepoint(mx, my):
                                current_val = getattr(self.current_params, elem['attr'])
                                setattr(self.current_params, elem['attr'], not current_val)
                                self.create_object()
                        elif elem['type'] == 'slider':
                            slider_rect = pygame.Rect(self.ui_x + 80, elem['y'] + 15, 200, 10)
                            if slider_rect.collidepoint(mx, my):
                                self.selected_slider = elem
                                self.dragging = True
                else:
                    # Canvas click - move object
                    self.current_params.x = mx
                    self.current_params.y = my
                    self.create_object()

            if event.type == pygame.MOUSEBUTTONUP:
                self.dragging = False
                self.selected_slider = None

            if event.type == pygame.MOUSEMOTION:
                if self.dragging and self.selected_slider:
                    mx, my = event.pos
                    elem = self.selected_slider
                    slider_x = self.ui_x + 80
                    slider_width = 200

                    t = max(0, min(1, (mx - slider_x) / slider_width))
                    value = elem['min'] + t * (elem['max'] - elem['min'])

                    setattr(self.current_params, elem['attr'], value)
                    self.create_object()

        return True

    def handle_button(self, button):
        """Handle button click"""
        action = button.get('action')

        if action == 'change_type':
            self.current_params.object_type = button['value']
            self.create_object()
            self.create_ui()  # Rebuild UI for new type
        elif action == 'add_object':
            # Create a copy and add to scene
            import copy
            new_params = copy.deepcopy(self.current_params)

            if new_params.object_type == ObjectType.STAR.value:
                self.objects.append(Star(new_params))
            elif new_params.object_type == ObjectType.BLACK_HOLE.value:
                self.objects.append(BlackHole(new_params))
            elif new_params.object_type == ObjectType.NEBULA.value:
                self.objects.append(Nebula(new_params))
            elif new_params.object_type in [ObjectType.PLANET.value, ObjectType.MOON.value]:
                self.objects.append(Planet(new_params))
        elif action == 'clear_scene':
            self.objects.clear()
        elif action == 'save_scene':
            self.save_scene()

    def save_scene(self):
        """Save scene to JSON"""
        scene_data = []
        for obj in self.objects:
            scene_data.append(asdict(obj.params))

        with open('celestial_scene.json', 'w') as f:
            json.dump(scene_data, f, indent=2)

        print("Scene saved to celestial_scene.json")

    def draw_ui(self):
        """Draw UI panel"""
        # UI background
        pygame.draw.rect(self.screen, (20, 20, 30),
                        (self.ui_x, 0, 300, self.height))

        # Draw UI elements
        for elem in self.ui_elements:
            if elem['type'] == 'label':
                text = self.font.render(elem['text'], True, (200, 200, 200))
                self.screen.blit(text, (self.ui_x + 10, elem['y']))

            elif elem['type'] == 'button':
                # Highlight if selected
                if elem.get('action') == 'change_type':
                    is_selected = elem['value'] == self.current_params.object_type
                    color = (80, 120, 200) if is_selected else (50, 50, 70)
                else:
                    color = (60, 100, 60)

                button_rect = pygame.Rect(self.ui_x + 10, elem['y'], 280, 30)
                pygame.draw.rect(self.screen, color, button_rect)
                pygame.draw.rect(self.screen, (100, 100, 120), button_rect, 2)

                text = self.small_font.render(elem['text'], True, (255, 255, 255))
                text_rect = text.get_rect(center=button_rect.center)
                self.screen.blit(text, text_rect)

            elif elem['type'] == 'slider':
                # Label
                label_text = self.small_font.render(elem['label'], True, (180, 180, 180))
                self.screen.blit(label_text, (self.ui_x + 10, elem['y']))

                # Slider track
                track_rect = pygame.Rect(self.ui_x + 80, elem['y'] + 15, 200, 10)
                pygame.draw.rect(self.screen, (40, 40, 50), track_rect)

                # Slider fill
                value = getattr(self.current_params, elem['attr'])
                t = (value - elem['min']) / (elem['max'] - elem['min'])
                fill_width = int(200 * t)
                fill_rect = pygame.Rect(self.ui_x + 80, elem['y'] + 15, fill_width, 10)
                pygame.draw.rect(self.screen, (100, 150, 255), fill_rect)

                # Value text
                if isinstance(value, float):
                    value_text = f"{value:.1f}"
                else:
                    value_text = str(int(value))
                val_surf = self.small_font.render(value_text, True, (200, 200, 200))
                self.screen.blit(val_surf, (self.ui_x + 10, elem['y'] + 20))

            elif elem['type'] == 'toggle':
                # Checkbox
                check_rect = pygame.Rect(self.ui_x + 10, elem['y'], 20, 20)
                pygame.draw.rect(self.screen, (40, 40, 50), check_rect)
                pygame.draw.rect(self.screen, (100, 100, 120), check_rect, 2)

                if getattr(self.current_params, elem['attr']):
                    pygame.draw.line(self.screen, (100, 255, 100),
                                   (self.ui_x + 12, elem['y'] + 10),
                                   (self.ui_x + 16, elem['y'] + 18), 3)
                    pygame.draw.line(self.screen, (100, 255, 100),
                                   (self.ui_x + 16, elem['y'] + 18),
                                   (self.ui_x + 28, elem['y'] + 5), 3)

                # Label
                label_text = self.small_font.render(elem['label'], True, (180, 180, 180))
                self.screen.blit(label_text, (self.ui_x + 40, elem['y']))

        # Instructions
        y = self.height - 100
        instructions = [
            "Click canvas to move object",
            "Drag sliders to adjust",
            "Add multiple objects!",
        ]
        for i, text in enumerate(instructions):
            surf = self.small_font.render(text, True, (120, 120, 130))
            self.screen.blit(surf, (self.ui_x + 10, y + i * 25))

    async def run(self):
        """Main loop"""
        running = True

        print("=" * 60)
        print("Celestial Object Creator Studio")
        print("=" * 60)
        print("Create amazing cosmic objects!")
        print("- Click canvas to position")
        print("- Use sliders to customize")
        print("- Add objects to build scenes")
        print("- Press ESC to exit")
        print("=" * 60)

        while running:
            dt = self.clock.tick(60) / 1000.0

            running = self.handle_events()

            # Update all objects
            if self.current_object:
                self.current_object.update(dt)
            for obj in self.objects:
                obj.update(dt)

            # Draw
            # Canvas background (space)
            canvas_rect = pygame.Rect(0, 0, self.canvas_width, self.canvas_height)
            self.screen.fill((5, 5, 15), canvas_rect)

            # Draw stars in background
            for _ in range(2):
                x = random.randint(0, self.canvas_width)
                y = random.randint(0, self.canvas_height)
                pygame.draw.circle(self.screen, (200, 200, 200), (x, y), 1)

            # Draw scene objects
            for obj in self.objects:
                obj.draw(self.screen)

            # Draw current object
            if self.current_object:
                self.current_object.draw(self.screen)

            # Draw canvas border
            pygame.draw.line(self.screen, (100, 100, 120),
                           (self.canvas_width, 0), (self.canvas_width, self.height), 2)

            # Draw UI
            self.draw_ui()

            # FPS
            fps = int(self.clock.get_fps())
            fps_text = self.small_font.render(f"FPS: {fps}", True, (100, 100, 100))
            self.screen.blit(fps_text, (10, 10))

            # Object count
            count_text = self.small_font.render(f"Objects: {len(self.objects)}", True, (100, 100, 100))
            self.screen.blit(count_text, (10, 35))

            pygame.display.flip()
            await asyncio.sleep(0)

        pygame.quit()


async def main():
    """Entry point"""
    studio = CelestialStudio()
    await studio.run()


if __name__ == "__main__":
    asyncio.run(main())
