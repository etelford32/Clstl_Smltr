FROM python:3.11-slim

# Install system dependencies for Pygame, OpenGL, and VNC
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    libgl1-mesa-glx \
    libglu1-mesa \
    libsdl2-2.0-0 \
    libsdl2-image-2.0-0 \
    libsdl2-mixer-2.0-0 \
    libsdl2-ttf-2.0-0 \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY star_simulation.py .
COPY main.py .

# Create supervisor config
RUN mkdir -p /var/log/supervisor

COPY <<EOF /etc/supervisor/conf.d/supervisord.conf
[supervisord]
nodaemon=true
user=root

[program:xvfb]
command=/usr/bin/Xvfb :99 -screen 0 1200x800x24
autorestart=true
priority=100

[program:fluxbox]
command=/usr/bin/fluxbox -display :99
autorestart=true
priority=200
environment=DISPLAY=":99"

[program:x11vnc]
command=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5900 -ncache 10
autorestart=true
priority=300

[program:star_simulation]
command=python star_simulation.py
autorestart=true
priority=400
environment=DISPLAY=":99"
stdout_logfile=/var/log/supervisor/star_simulation.log
stderr_logfile=/var/log/supervisor/star_simulation_err.log
EOF

# Expose VNC port
EXPOSE 5900

# Set display environment variable
ENV DISPLAY=:99

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
