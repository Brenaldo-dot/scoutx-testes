// Sem foto de verdade cadastrada em lugar nenhum por padrão — iniciais num
// círculo gradiente fazem o papel de avatar até a pessoa subir uma foto
// própria (ver AvatarCard em Conta.jsx). Usado no rodapé do menu (Layout.jsx)
// e na tela de Minha Conta.
export function initials(name) {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// Redimensiona no PRÓPRIO navegador antes de subir — sem isso uma foto de
// celular moderna (4-12 MB) iria inteira pro banco a cada troca de avatar.
// Sem dependência nova: FileReader + <canvas> já dão conta.
export function resizeImageToDataUrl(file, maxDim = 256, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Escolha um arquivo de imagem (JPG, PNG…).'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Não consegui ler esse arquivo.'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Esse arquivo não parece ser uma imagem válida.'))
      img.onload = () => {
        let { width, height } = img
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width)
          width = maxDim
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height)
          height = maxDim
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}
