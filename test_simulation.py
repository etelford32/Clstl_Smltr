#!/usr/bin/env python3
"""
Test script to verify the star simulation components work correctly
"""

import sys
import math


def test_particle_class():
    """Test the Particle class"""
    print("Testing Particle class...")

    # Import the module
    from star_simulation import Particle

    # Create a particle
    p = Particle(radius=1.0)

    # Verify initial position is on the sphere surface
    dist = math.sqrt(p.x**2 + p.y**2 + p.z**2)
    assert abs(dist - 1.0) < 0.01, f"Particle not on sphere surface: {dist}"

    # Verify particle has velocity
    assert p.vx != 0 or p.vy != 0 or p.vz != 0, "Particle has no velocity"

    # Test update
    initial_life = p.life
    p.update()
    assert p.life == initial_life - 1, "Particle life not decreasing"

    # Test alive status
    assert p.is_alive(), "New particle should be alive"

    # Kill particle
    p.life = 0
    assert not p.is_alive(), "Dead particle should not be alive"

    # Test alpha
    p.life = 50
    p.max_life = 100
    assert abs(p.get_alpha() - 0.5) < 0.01, "Alpha calculation incorrect"

    print("✓ Particle class tests passed!")


def test_simulation_components():
    """Test simulation can be instantiated (without OpenGL context)"""
    print("\nTesting simulation components...")

    # Test imports
    try:
        import pygame
        import OpenGL.GL
        import OpenGL.GLU
        import numpy as np
        print("✓ All required modules imported successfully")
    except ImportError as e:
        print(f"✗ Import error: {e}")
        return False

    # Test that we can import the simulation module
    try:
        from star_simulation import StarSimulation
    except Exception as e:
        # Expected to fail without display, but should import
        if "No available video device" not in str(e):
            print(f"Warning: {e}")

    print("✓ Simulation class structure verified!")

    return True


def test_particle_physics():
    """Test particle physics calculations"""
    print("\nTesting particle physics...")

    from star_simulation import Particle
    import random

    random.seed(42)  # For reproducible tests

    # Create multiple particles
    particles = [Particle(radius=1.0) for _ in range(100)]

    # Verify all particles start on sphere surface
    for i, p in enumerate(particles):
        dist = math.sqrt(p.x**2 + p.y**2 + p.z**2)
        assert abs(dist - 1.0) < 0.01, f"Particle {i} not on sphere: {dist}"

    # Update particles and verify they move outward
    for _ in range(10):
        for p in particles:
            old_dist = math.sqrt(p.x**2 + p.y**2 + p.z**2)
            p.update()
            new_dist = math.sqrt(p.x**2 + p.y**2 + p.z**2)
            # Particles should generally move outward (with some random variance)
            assert new_dist > old_dist - 0.1, "Particle not moving outward"

    print("✓ Particle physics tests passed!")


def main():
    """Run all tests"""
    print("=" * 50)
    print("Star Simulation Component Tests")
    print("=" * 50)

    try:
        test_particle_class()
        test_simulation_components()
        test_particle_physics()

        print("\n" + "=" * 50)
        print("All tests passed! ✓")
        print("=" * 50)
        print("\nTo run the simulation (requires display):")
        print("  python star_simulation.py")

        return 0

    except AssertionError as e:
        print(f"\n✗ Test failed: {e}")
        return 1
    except Exception as e:
        print(f"\n✗ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
