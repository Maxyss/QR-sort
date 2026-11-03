# Sorteos QR

Cada sorteo tiene su propio código QR. Los participantes lo escanean y se inscriben (nombre + email o teléfono). Vos entrás a `/admin`, ves los inscriptos, sorteás y creás sorteos nuevos.

## 1. Subirlo a GitHub

```bash
cd sorteos-qr
git init
git add .
git commit -m "Sorteos QR"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

(Si el repo ya existe con archivos viejos: `git push -u origin main --force`.)

## 2. Desplegarlo en Render

1. **Base de datos (gratis):** creá un cluster en [MongoDB Atlas](https://www.mongodb.com/atlas), un usuario de base de datos y, en *Network Access*, permití `0.0.0.0/0`. Copiá la cadena de conexión (`mongodb+srv://...`).
2. **GitHub:** subí esta carpeta a un repositorio.
3. **Render:** *New → Web Service* (o *Blueprint* para usar `render.yaml`), conectá el repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. **Variables de entorno:**
   - `MONGODB_URI`: la cadena de Atlas
   - `ADMIN_PASSWORD`: la contraseña con la que vas a entrar al panel
   - (opcional) `BASE_URL`: tu dominio propio si lo usás, por ejemplo `https://sorteos.midominio.com`
   - (opcional) `SESSION_SECRET`: cualquier texto largo y aleatorio
5. Cuando termine el deploy, entrá a `https://TU-APP.onrender.com/admin`.

## Uso

- **Crear sorteo:** nombre, premio, cantidad de ganadores. Se genera el QR y el link al instante.
- **Compartir:** descargá el QR en PNG o copiá el link.
- **Sortear:** botón *Sortear*. Podés repetirlo para sumar más ganadores o suplentes; nunca sale dos veces la misma persona.
- **Cerrar/reabrir inscripciones**, quitar inscriptos, reiniciar el sorteo y exportar CSV.

## Notas

- El plan gratuito de Render se "duerme" tras 15 minutos sin tráfico y tarda ~50 s en despertar. Abrí la app unos minutos antes del evento o usá un plan pago.
- No se puede inscribir dos veces el mismo email/teléfono en el mismo sorteo.

## Desarrollo local

```bash
npm install
MONGODB_URI="mongodb+srv://..." ADMIN_PASSWORD="clave" npm start
```
