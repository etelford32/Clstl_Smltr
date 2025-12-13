#!/usr/bin/env python3
"""
3D Star Simulation with Solar Wind Particles
Uses Pygame + OpenGL for rendering with shader effects
"""

import pygame
from pygame.locals import *
from OpenGL.GL import *
from OpenGL.GLU import *
import numpy as np
import math
import random


class Particle:
    """Represents a solar wind particle"""
    def __init__(self, radius):
        # Start at the surface of the star
        theta = random.uniform(0, 2 * math.pi)
        phi = random.uniform(0, math.pi)

        self.x = radius * math.sin(phi) * math.cos(theta)
        self.y = radius * math.sin(phi) * math.sin(theta)
        self.z = radius * math.cos(phi)

        # Velocity pointing outward from center
        speed = random.uniform(0.02, 0.05)
        norm = math.sqrt(self.x**2 + self.y**2 + self.z**2)
        self.vx = (self.x / norm) * speed
        self.vy = (self.y / norm) * speed
        self.vz = (self.z / norm) * speed

        # Add some randomness to velocity
        self.vx += random.uniform(-0.01, 0.01)
        self.vy += random.uniform(-0.01, 0.01)
        self.vz += random.uniform(-0.01, 0.01)

        self.life = random.uniform(80, 150)
        self.max_life = self.life
        self.size = random.uniform(2, 5)

    def update(self):
        """Update particle position and life"""
        self.x += self.vx
        self.y += self.vy
        self.z += self.vz
        self.life -= 1

    def is_alive(self):
        """Check if particle is still alive"""
        return self.life > 0

    def get_alpha(self):
        """Get alpha value based on life remaining"""
        return self.life / self.max_life


class StarSimulation:
    """Main star simulation class"""

    def __init__(self, width=1200, height=800):
        self.width = width
        self.height = height
        self.star_radius = 1.0
        self.particles = []
        self.max_particles = 2000
        self.rotation_x = 0
        self.rotation_y = 0
        self.camera_distance = 5.0

        # Initialize Pygame and OpenGL
        pygame.init()
        self.screen = pygame.display.set_mode((width, height), DOUBLEBUF | OPENGL)
        pygame.display.set_caption("3D Star Simulation with Solar Wind")

        # Setup OpenGL
        self.setup_opengl()

        # Compile shaders
        self.shader_program = self.create_shader_program()

        # Create display lists for optimized rendering
        self.star_display_list = self.create_star_display_list()

    def setup_opengl(self):
        """Initialize OpenGL settings"""
        glEnable(GL_DEPTH_TEST)
        glEnable(GL_BLEND)
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)
        glEnable(GL_POINT_SMOOTH)
        glHint(GL_POINT_SMOOTH_HINT, GL_NICEST)

        # Setup lighting
        glEnable(GL_LIGHTING)
        glEnable(GL_LIGHT0)
        glEnable(GL_COLOR_MATERIAL)
        glColorMaterial(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE)

        # Light properties
        glLightfv(GL_LIGHT0, GL_POSITION, [0, 0, 0, 1])
        glLightfv(GL_LIGHT0, GL_AMBIENT, [0.3, 0.3, 0.3, 1])
        glLightfv(GL_LIGHT0, GL_DIFFUSE, [1, 1, 1, 1])
        glLightfv(GL_LIGHT0, GL_SPECULAR, [1, 1, 1, 1])

        # Material properties
        glMaterialfv(GL_FRONT, GL_SPECULAR, [1, 1, 1, 1])
        glMaterialf(GL_FRONT, GL_SHININESS, 50)

        # Perspective
        glMatrixMode(GL_PROJECTION)
        gluPerspective(45, self.width / self.height, 0.1, 50.0)
        glMatrixMode(GL_MODELVIEW)

    def create_shader_program(self):
        """Create GLSL shader program for star glow effect"""
        vertex_shader_code = """
        #version 120
        varying vec3 normal;
        varying vec3 vertex;

        void main() {
            normal = normalize(gl_NormalMatrix * gl_Normal);
            vertex = vec3(gl_ModelViewMatrix * gl_Vertex);
            gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
            gl_FrontColor = gl_Color;
        }
        """

        fragment_shader_code = """
        #version 120
        varying vec3 normal;
        varying vec3 vertex;

        void main() {
            vec3 N = normalize(normal);
            vec3 V = normalize(-vertex);

            // Fresnel-like rim lighting effect
            float rim = 1.0 - max(dot(V, N), 0.0);
            rim = pow(rim, 3.0);

            // Star core color (yellow-orange)
            vec3 coreColor = vec3(1.0, 0.9, 0.3);

            // Add glow
            vec3 glowColor = vec3(1.0, 0.7, 0.2);
            vec3 finalColor = mix(coreColor, glowColor, rim);

            // Add extra brightness
            finalColor += rim * vec3(1.0, 0.5, 0.1);

            gl_FragColor = vec4(finalColor, 1.0);
        }
        """

        try:
            # Compile vertex shader
            vertex_shader = glCreateShader(GL_VERTEX_SHADER)
            glShaderSource(vertex_shader, vertex_shader_code)
            glCompileShader(vertex_shader)

            # Check vertex shader compilation
            if not glGetShaderiv(vertex_shader, GL_COMPILE_STATUS):
                error = glGetShaderInfoLog(vertex_shader).decode()
                print(f"Vertex shader compilation error: {error}")
                return None

            # Compile fragment shader
            fragment_shader = glCreateShader(GL_FRAGMENT_SHADER)
            glShaderSource(fragment_shader, fragment_shader_code)
            glCompileShader(fragment_shader)

            # Check fragment shader compilation
            if not glGetShaderiv(fragment_shader, GL_COMPILE_STATUS):
                error = glGetShaderInfoLog(fragment_shader).decode()
                print(f"Fragment shader compilation error: {error}")
                return None

            # Link shader program
            program = glCreateProgram()
            glAttachShader(program, vertex_shader)
            glAttachShader(program, fragment_shader)
            glLinkProgram(program)

            # Check program linking
            if not glGetProgramiv(program, GL_LINK_STATUS):
                error = glGetProgramInfoLog(program).decode()
                print(f"Shader program linking error: {error}")
                return None

            return program

        except Exception as e:
            print(f"Shader creation failed: {e}")
            return None

    def create_star_display_list(self):
        """Create a display list for the star sphere"""
        display_list = glGenLists(1)
        glNewList(display_list, GL_COMPILE)

        # Create a detailed sphere
        quadric = gluNewQuadric()
        gluQuadricNormals(quadric, GLU_SMOOTH)
        gluQuadricTexture(quadric, GL_TRUE)
        gluSphere(quadric, self.star_radius, 50, 50)
        gluDeleteQuadric(quadric)

        glEndList()
        return display_list

    def draw_star(self):
        """Draw the star with shader effects"""
        glPushMatrix()

        # Use shader if available
        if self.shader_program:
            glUseProgram(self.shader_program)

        # Set star color
        glColor3f(1.0, 0.9, 0.3)

        # Draw the sphere
        glCallList(self.star_display_list)

        # Disable shader
        if self.shader_program:
            glUseProgram(0)

        # Draw glow halo
        glDisable(GL_LIGHTING)
        glDepthMask(GL_FALSE)

        # Outer glow
        glColor4f(1.0, 0.7, 0.2, 0.3)
        quadric = gluNewQuadric()
        gluSphere(quadric, self.star_radius * 1.3, 30, 30)

        # Inner glow
        glColor4f(1.0, 0.9, 0.5, 0.2)
        gluSphere(quadric, self.star_radius * 1.15, 30, 30)
        gluDeleteQuadric(quadric)

        glDepthMask(GL_TRUE)
        glEnable(GL_LIGHTING)

        glPopMatrix()

    def spawn_particles(self, count):
        """Spawn new solar wind particles"""
        for _ in range(count):
            if len(self.particles) < self.max_particles:
                self.particles.append(Particle(self.star_radius))

    def update_particles(self):
        """Update all particles"""
        # Remove dead particles
        self.particles = [p for p in self.particles if p.is_alive()]

        # Update living particles
        for particle in self.particles:
            particle.update()

    def draw_particles(self):
        """Draw all solar wind particles"""
        glDisable(GL_LIGHTING)
        glPointSize(3)

        glBegin(GL_POINTS)
        for particle in self.particles:
            # Color gradient from yellow to white to blue
            alpha = particle.get_alpha()
            dist = math.sqrt(particle.x**2 + particle.y**2 + particle.z**2)

            # Color changes with distance from star
            if dist < 2.0:
                # Close to star: yellow-orange
                glColor4f(1.0, 0.8, 0.3, alpha)
            elif dist < 3.5:
                # Medium distance: white-yellow
                glColor4f(1.0, 1.0, 0.7, alpha * 0.8)
            else:
                # Far away: blue-white (cooler)
                glColor4f(0.7, 0.8, 1.0, alpha * 0.6)

            glVertex3f(particle.x, particle.y, particle.z)
        glEnd()

        glEnable(GL_LIGHTING)

    def handle_input(self):
        """Handle user input"""
        keys = pygame.key.get_pressed()

        # Camera rotation
        if keys[K_LEFT]:
            self.rotation_y -= 2
        if keys[K_RIGHT]:
            self.rotation_y += 2
        if keys[K_UP]:
            self.rotation_x -= 2
        if keys[K_DOWN]:
            self.rotation_x += 2

        # Camera zoom
        if keys[K_w]:
            self.camera_distance = max(2.0, self.camera_distance - 0.1)
        if keys[K_s]:
            self.camera_distance = min(10.0, self.camera_distance + 0.1)

        # Reset view
        if keys[K_r]:
            self.rotation_x = 0
            self.rotation_y = 0
            self.camera_distance = 5.0

    def run(self):
        """Main simulation loop"""
        clock = pygame.time.Clock()
        running = True

        print("=== Star Simulation Controls ===")
        print("Arrow Keys: Rotate view")
        print("W/S: Zoom in/out")
        print("R: Reset view")
        print("ESC: Exit")
        print("================================")

        while running:
            # Handle events
            for event in pygame.event.get():
                if event.type == QUIT:
                    running = False
                if event.type == KEYDOWN:
                    if event.key == K_ESCAPE:
                        running = False

            # Handle continuous input
            self.handle_input()

            # Spawn new particles
            self.spawn_particles(10)

            # Update particles
            self.update_particles()

            # Clear screen
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)
            glLoadIdentity()

            # Set camera position
            gluLookAt(0, 0, self.camera_distance,
                     0, 0, 0,
                     0, 1, 0)

            # Apply rotations
            glRotatef(self.rotation_x, 1, 0, 0)
            glRotatef(self.rotation_y, 0, 1, 0)

            # Automatic slow rotation for effect
            glRotatef(pygame.time.get_ticks() * 0.01, 0, 1, 0)

            # Draw the star
            self.draw_star()

            # Draw particles
            self.draw_particles()

            # Update display
            pygame.display.flip()
            clock.tick(60)

        pygame.quit()


def main():
    """Entry point"""
    try:
        sim = StarSimulation()
        sim.run()
    except Exception as e:
        print(f"Error running simulation: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
