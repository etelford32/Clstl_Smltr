use bevy::app::AppExit;
use bevy::input::ButtonInput;
use bevy::prelude::*;

#[derive(Component)]
pub struct CameraController {
    pub rotation_speed: f32,
    pub zoom_speed: f32,
    pub distance: f32,
    pub angle_x: f32,
    pub angle_y: f32,
}

pub fn camera_controller(
    keyboard: Res<ButtonInput<KeyCode>>,
    time: Res<Time>,
    mut query: Query<(&mut Transform, &mut CameraController)>,
) {
    for (mut transform, mut controller) in query.iter_mut() {
        let delta = time.delta_secs();

        if keyboard.pressed(KeyCode::ArrowLeft) {
            controller.angle_x -= controller.rotation_speed * delta;
        }
        if keyboard.pressed(KeyCode::ArrowRight) {
            controller.angle_x += controller.rotation_speed * delta;
        }
        if keyboard.pressed(KeyCode::ArrowUp) {
            controller.angle_y = (controller.angle_y + controller.rotation_speed * delta)
                .min(std::f32::consts::FRAC_PI_2 - 0.1);
        }
        if keyboard.pressed(KeyCode::ArrowDown) {
            controller.angle_y = (controller.angle_y - controller.rotation_speed * delta)
                .max(-std::f32::consts::FRAC_PI_2 + 0.1);
        }

        if keyboard.pressed(KeyCode::KeyW) {
            controller.distance = (controller.distance - controller.zoom_speed * delta).max(5.0);
        }
        if keyboard.pressed(KeyCode::KeyS) {
            controller.distance = (controller.distance + controller.zoom_speed * delta).min(50.0);
        }

        if keyboard.just_pressed(KeyCode::KeyR) {
            controller.angle_x = 0.0;
            controller.angle_y = 0.3;
            controller.distance = 15.0;
        }

        let x = controller.distance * controller.angle_y.cos() * controller.angle_x.sin();
        let y = controller.distance * controller.angle_y.sin();
        let z = controller.distance * controller.angle_y.cos() * controller.angle_x.cos();

        transform.translation = Vec3::new(x, y, z);
        transform.look_at(Vec3::ZERO, Vec3::Y);
    }
}

pub fn handle_exit(keyboard: Res<ButtonInput<KeyCode>>, mut exit: MessageWriter<AppExit>) {
    if keyboard.just_pressed(KeyCode::Escape) {
        exit.write(AppExit::Success);
    }
}
