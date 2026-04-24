# Lyrickahoot

Un juego de karaoke educativo con trivia de letras de canciones, integrado con Classroom Trading.

## Características

- Juego multiplayer en tiempo real con WebSockets
- Integración con Classroom Trading para autenticación y pagos MXP
- Control manual de preguntas por el profesor
- Editor robusto para crear ejercicios
- Sincronización de letras con YouTube

## Instalación

1. Clona el repositorio
2. Instala dependencias: `npm install`
3. Configura variables de entorno en `.env`:
   ```
   INTERNAL_API_SECRET=tu_secreto_aqui
   PORT=3000
   ADMIN_PIN=admin123
   ```
4. Ejecuta: `npm start`

## Uso

### Para Profesores
1. Ve a `http://localhost:3000/game/game-screen.html`
2. Ingresa tu ID y NIP (si eres ID 64, acceso directo como admin)
3. Si no eres admin, ingresa el PIN de respaldo (admin123)
4. Crea o carga un código de sala
5. Controla el video y abre preguntas manualmente con el botón ❓

### Para Estudiantes
1. Ve a `http://localhost:3000/game/player.html`
2. Ingresa el código de sala
3. Inicia sesión con ID y NIP (validado contra Classroom Trading)
4. Juega respondiendo preguntas

### Crear Ejercicios
1. Usa `editor/step1-lyrics.html` para sincronizar letras con YouTube
2. Usa `editor/step2-exercise.html` para seleccionar palabras como preguntas
3. Descarga el JSON y colócalo en `data/`

## API

- `POST /api/login`: Valida usuario contra Classroom Trading
- `POST /api/pay-mxp`: Proxy para pagos MXP

## Seguridad

- Autenticación requerida para pagos
- Validaciones de entrada
- Timeouts en requests externos
- PIN para acceso host (configurable via env)

## Mejoras Recientes

- Login integrado con Classroom Trading
- Control manual de preguntas
- Editor mejorado con validaciones
- Validaciones de seguridad en API