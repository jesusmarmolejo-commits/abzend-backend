/**
 * Script de uso único para obtener el refresh token de Google OAuth2.
 * Ejecutar: node .github/scripts/get-refresh-token.js
 * Eliminar este archivo después de obtener el token.
 */
const { google } = require('googleapis')
const readline = require('readline')

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive'],
  prompt: 'consent',
})

console.log('\n1. Abre este enlace en tu navegador:\n')
console.log(authUrl)
console.log('\n2. Autoriza el acceso con tu cuenta de Google.')
console.log('3. Copia el código que aparece y pégalo aquí:\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

rl.question('Código de autorización: ', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2Client.getToken(code.trim())
    console.log('\n✅ ¡Listo! Guarda estos valores como secrets en GitHub:\n')
    console.log('GOOGLE_CLIENT_ID=' + CLIENT_ID)
    console.log('GOOGLE_CLIENT_SECRET=' + CLIENT_SECRET)
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token)
    console.log('\n⚠️  Elimina este archivo después de copiar el token.')
  } catch (e) {
    console.error('Error obteniendo el token:', e.message)
  }
})
