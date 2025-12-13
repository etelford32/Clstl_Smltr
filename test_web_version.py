#!/usr/bin/env python3
"""
Test script for the web-compatible version
"""

import sys


def test_web_version_imports():
    """Test that web version can be imported"""
    print("Testing web version imports...")

    try:
        import asyncio
        import pygame
        import math
        import random
        print("✓ All standard imports successful")
    except ImportError as e:
        print(f"✗ Import error: {e}")
        return False

    try:
        from main import Particle, Star2DSimulation, main
        print("✓ Main module imports successful")
    except Exception as e:
        print(f"✗ Main module import error: {e}")
        return False

    return True


def test_particle_creation():
    """Test web version particle creation"""
    print("\nTesting particle creation...")

    from main import Particle

    # Create particle
    p = Particle(radius=80.0, x=400, y=300)

    # Verify attributes exist
    assert hasattr(p, 'x'), "Missing x attribute"
    assert hasattr(p, 'y'), "Missing y attribute"
    assert hasattr(p, 'vx'), "Missing vx attribute"
    assert hasattr(p, 'vy'), "Missing vy attribute"
    assert hasattr(p, 'life'), "Missing life attribute"

    # Verify methods
    assert callable(p.update), "Missing update method"
    assert callable(p.is_alive), "Missing is_alive method"
    assert callable(p.get_alpha), "Missing get_alpha method"

    # Test update
    old_x, old_y = p.x, p.y
    p.update()
    assert p.x != old_x or p.y != old_y, "Particle not moving"

    # Test alive
    assert p.is_alive(), "New particle should be alive"

    print("✓ Particle class working correctly")
    return True


def test_async_structure():
    """Test async/await structure for web compatibility"""
    print("\nTesting async structure...")

    import inspect
    from main import main

    # Verify main is async
    assert inspect.iscoroutinefunction(main), "main() must be async for web deployment"

    print("✓ Async structure correct for Pygbag")
    return True


def test_simulation_structure():
    """Test simulation class structure"""
    print("\nTesting simulation structure...")

    from main import Star2DSimulation

    # Verify methods exist
    required_methods = [
        'create_star_surface',
        'spawn_particles',
        'update_particles',
        'draw_star',
        'draw_particles',
        'handle_events',
        'run'
    ]

    for method in required_methods:
        assert hasattr(Star2DSimulation, method), f"Missing method: {method}"

    print("✓ Simulation class structure valid")
    return True


def main_test():
    """Run all tests"""
    print("=" * 60)
    print("Web Version Component Tests")
    print("=" * 60)
    print()

    tests = [
        test_web_version_imports,
        test_particle_creation,
        test_async_structure,
        test_simulation_structure,
    ]

    failed = []

    for test in tests:
        try:
            if not test():
                failed.append(test.__name__)
        except AssertionError as e:
            print(f"✗ {test.__name__} failed: {e}")
            failed.append(test.__name__)
        except Exception as e:
            print(f"✗ {test.__name__} error: {e}")
            failed.append(test.__name__)

    print()
    print("=" * 60)

    if failed:
        print(f"❌ {len(failed)} test(s) failed:")
        for name in failed:
            print(f"  - {name}")
        print("=" * 60)
        return 1
    else:
        print("✅ All web version tests passed!")
        print()
        print("Ready to deploy:")
        print("  1. pygbag main.py         (test locally)")
        print("  2. ./deploy.sh            (deployment menu)")
        print("  3. docker-compose up      (Docker with VNC)")
        print("=" * 60)
        return 0


if __name__ == "__main__":
    sys.exit(main_test())
