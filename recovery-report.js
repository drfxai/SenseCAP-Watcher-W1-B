export function verifiedPreviousStage(value, expectedEui) {
  if(!value || value.device?.eui !== expectedEui || value.stages?.esp32?.verified !== true || value.stages.esp32.factoryPartitionPreserved !== true || value.stages.esp32.version !== '1.1.7') {
    throw new Error('Report is not a verified ESP32 stage for this device');
  }
  return {...value.stages.esp32, importedFromReport:true};
}
