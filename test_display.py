#!/usr/bin/env python3
"""
Simple display test to diagnose rendering issues
"""

import pygame
import sys

def test_basic_display():
    """Test if pygame can display anything"""
    print("=" * 60)
    print("Pygame Display Test")
    print("=" * 60)

    try:
        print("1. Initializing Pygame...")
        pygame.init()
        print("   ✓ Pygame initialized")

        print("\n2. Creating display...")
        screen = pygame.display.set_mode((800, 600))
        pygame.display.set_caption("Display Test - You should see colored shapes!")
        print("   ✓ Display created (800x600)")

        print("\n3. Drawing test pattern...")
        clock = pygame.time.Clock()

        print("\n" + "=" * 60)
        print("WINDOW SHOULD NOW BE VISIBLE!")
        print("You should see:")
        print("  - Black background")
        print("  - Red circle (top-left)")
        print("  - Green square (top-right)")
        print("  - Blue rectangle (bottom)")
        print("  - Yellow text")
        print("\nPress ESC or close window to exit")
        print("=" * 60 + "\n")

        font = pygame.font.Font(None, 36)
        running = True
        frame = 0

        while running:
            # Handle events
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                    print("Window closed by user")
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_ESCAPE:
                        running = False
                        print("ESC pressed")

            # Clear screen to black
            screen.fill((0, 0, 0))

            # Draw test shapes
            # Red circle
            pygame.draw.circle(screen, (255, 0, 0), (200, 150), 80)

            # Green square
            pygame.draw.rect(screen, (0, 255, 0), (500, 100, 150, 150))

            # Blue rectangle
            pygame.draw.rect(screen, (0, 0, 255), (200, 400, 400, 100))

            # Yellow text
            text = font.render("Display Working! Frame: " + str(frame), True, (255, 255, 0))
            screen.blit(text, (250, 250))

            # White text with instructions
            small_font = pygame.font.Font(None, 24)
            inst = small_font.render("Press ESC to exit", True, (255, 255, 255))
            screen.blit(inst, (300, 550))

            # Update display
            pygame.display.flip()

            frame += 1
            if frame % 60 == 0:
                print(f"  Still running... frame {frame}, FPS: {int(clock.get_fps())}")

            clock.tick(60)

        pygame.quit()
        print("\n✓ Test completed successfully!")
        print("If you saw the colored shapes, your display is working fine.")
        return True

    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def check_environment():
    """Check environment and display info"""
    print("\nEnvironment Check:")
    print("-" * 60)

    import platform
    print(f"Platform: {platform.system()} {platform.release()}")
    print(f"Python: {sys.version}")

    try:
        import pygame
        print(f"Pygame: {pygame.version.ver}")
        print(f"SDL: {pygame.version.SDL}")
    except:
        print("Pygame: NOT INSTALLED")

    # Check for display
    import os
    display = os.environ.get('DISPLAY', 'Not set')
    print(f"DISPLAY environment: {display}")

    print("-" * 60)


if __name__ == "__main__":
    check_environment()
    print()

    if test_basic_display():
        print("\n✅ Your display system is working!")
        print("\nIf the celestial studio isn't showing:")
        print("1. Check the console for error messages")
        print("2. Make sure you're clicking on the canvas (left side)")
        print("3. Try adjusting the Size slider")
        print("4. The object follows your mouse on the canvas")
    else:
        print("\n❌ Display test failed!")
        print("\nPossible solutions:")
        print("1. If on Linux/Mac: Check DISPLAY variable is set")
        print("2. If remote: Use X11 forwarding or VNC")
        print("3. Try the Docker VNC option: docker-compose up")
        print("4. Use Pygbag for browser: pygbag celestial_studio.py")
