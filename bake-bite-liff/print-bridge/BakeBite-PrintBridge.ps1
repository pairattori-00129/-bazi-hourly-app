#requires -Version 5.1
# Windows pilot: one cashier computer. Uses installed printer names, never changes drivers.
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:Api='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/pos-api'
$script:StationApi='https://oplwrlljqwgxnrqrdufp.supabase.co/functions/v1/station-api'
$script:Token=$null
$script:Root=Join-Path $env:LOCALAPPDATA 'BakeBitePrintBridge'
New-Item -ItemType Directory -Force -Path $script:Root|Out-Null
$script:StatePath=Join-Path $script:Root 'state.json'
$script:ConfigPath=Join-Path $script:Root 'config.json'
$mutex=New-Object System.Threading.Mutex($false,'Local\BakeBitePrintBridge')
if(-not $mutex.WaitOne(0)){[Windows.Forms.MessageBox]::Show('Print Bridge เปิดอยู่แล้ว')|Out-Null;exit}
function Save-Json($Path,$Value){
    $temp=$Path+'.tmp'
    $Value|ConvertTo-Json -Depth 15|Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Convert-ToMap($Value){
    if($null -eq $Value){return $null}
    if($Value -is [System.Management.Automation.PSCustomObject]){
        $map=@{};foreach($p in $Value.PSObject.Properties){$map[$p.Name]=Convert-ToMap $p.Value};return $map
    }
    if($Value -is [System.Array]){return ,@($Value|ForEach-Object{Convert-ToMap $_})}
    return $Value
}
function Api-Get([string]$Query){
    $r=Invoke-RestMethod -Method Get -Uri ($script:Api+'?'+$Query) -Headers @{Authorization=('Bearer '+$script:Token)} -TimeoutSec 20
    if(-not $r.ok){throw 'API rejected request'};return $r
}
function Label-On($Form,[string]$Text,[int]$Y){
    $l=New-Object Windows.Forms.Label
    $l.Text=$Text;$l.Location=New-Object Drawing.Point(20,$Y);$l.Size=New-Object Drawing.Size(550,26)
    $Form.Controls.Add($l)
}
function Get-Login{
    $f=New-Object Windows.Forms.Form
    $f.Text='Bake & Bite Print Bridge - เข้าสู่ระบบ POS'
    $f.Size=New-Object Drawing.Size(490,310);$f.StartPosition='CenterScreen'
    $f.Font=New-Object Drawing.Font('Segoe UI',10)
    Label-On $f 'ใช้รหัส POS ของร้าน ไม่ใช่รหัสผ่าน Windows' 18
    $role=New-Object Windows.Forms.ComboBox
    $role.DropDownStyle='DropDownList';[void]$role.Items.Add('user');[void]$role.Items.Add('admin')
    $role.SelectedIndex=0;$role.Location=New-Object Drawing.Point(20,54);$f.Controls.Add($role)
    Label-On $f 'รหัสผ่าน (ไม่บันทึกลงไฟล์)' 94
    $password=New-Object Windows.Forms.TextBox
    $password.UseSystemPasswordChar=$true;$password.Location=New-Object Drawing.Point(20,123)
    $password.Width=420;$f.Controls.Add($password)
    $message=New-Object Windows.Forms.Label
    $message.Location=New-Object Drawing.Point(20,158);$message.Size=New-Object Drawing.Size(420,42);$f.Controls.Add($message)
    $login=New-Object Windows.Forms.Button
    $login.Text='เข้าสู่ระบบ';$login.Location=New-Object Drawing.Point(20,205);$login.Size=New-Object Drawing.Size(130,35);$f.Controls.Add($login)
    $login.Add_Click({
        $login.Enabled=$false
        try{
            $body=@{role=[string]$role.SelectedItem;password=$password.Text}|ConvertTo-Json
            $r=Invoke-RestMethod -Uri ($script:Api+'?action=login') -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
            if(-not $r.ok -or -not $r.token){throw 'Login failed'}
            $script:Token=[string]$r.token;$password.Clear();$f.DialogResult='OK';$f.Close()
        }catch{$password.Clear();$message.Text='เข้าสู่ระบบไม่สำเร็จ ตรวจรหัสและอินเทอร์เน็ต';$login.Enabled=$true}
    })
    $f.AcceptButton=$login;$result=$f.ShowDialog();$f.Dispose()
    return ($result -eq [Windows.Forms.DialogResult]::OK)
}
function Printer-Box($Form,$Printers,[int]$Y,[string]$Preferred){
    $c=New-Object Windows.Forms.ComboBox;$c.DropDownStyle='DropDownList'
    $c.Location=New-Object Drawing.Point(20,$Y);$c.Width=550
    foreach($p in $Printers){[void]$c.Items.Add([string]$p)}
    $c.SelectedItem=$Preferred;if($c.SelectedIndex -lt 0){$c.SelectedIndex=0}
    $Form.Controls.Add($c);return $c
}
function Get-Config{
    $printers=@([Drawing.Printing.PrinterSettings]::InstalledPrinters|ForEach-Object{[string]$_})
    if($printers.Count -eq 0){throw 'ไม่พบเครื่องพิมพ์ใน Windows'}
    $old=@{};if(Test-Path $script:ConfigPath){$old=Convert-ToMap (Get-Content $script:ConfigPath -Raw|ConvertFrom-Json)}
    $f=New-Object Windows.Forms.Form;$f.Text='Bake & Bite - จับคู่เครื่องพิมพ์'
    $f.Size=New-Object Drawing.Size(610,530);$f.StartPosition='CenterScreen';$f.Font=New-Object Drawing.Font('Segoe UI',10)
    Label-On $f 'เครื่องเคาน์เตอร์: ใบเสร็จ + ใบจัดอาหารรวม' 16
    $preferred=if($old.counter){$old.counter}else{'XP-80C'}
    $counter=Printer-Box $f $printers 45 $preferred
    Label-On $f 'เครื่องห้องครัว: ใบงานตามสถานีที่เลือก' 85
    $preferred=if($old.kitchen){$old.kitchen}else{'XP-C30'}
    $kitchen=Printer-Box $f $printers 114 $preferred
    Label-On $f 'สถานีที่ส่งเข้าเครื่องห้องครัว' 154
    $station=New-Object Windows.Forms.ComboBox
    $station.DropDownStyle='DropDownList';$station.Location=New-Object Drawing.Point(20,183);$station.Width=550
    $r=Invoke-RestMethod -Uri ($script:StationApi+'?action=config') -Headers @{Authorization=('Bearer '+$script:Token)} -TimeoutSec 20
    if(-not $r.ok){throw 'โหลดสถานีไม่สำเร็จ'}
    $stationRows=@($r.stations|Where-Object{$_.enabled -and $_.printer_enabled})
    if($stationRows.Count -eq 0){throw 'เปิดใช้งานสถานีและเครื่องพิมพ์ในหน้า Display and Printer Settings ก่อน'}
    foreach($row in $stationRows){[void]$station.Items.Add([string]$row.name)}
    $station.SelectedIndex=0
    for($i=0;$i -lt $stationRows.Count;$i++){
        if(($old.station_id -and $stationRows[$i].id -eq $old.station_id) -or (-not $old.station_id -and $stationRows[$i].name -eq 'ครัวไทย')){$station.SelectedIndex=$i}
    }
    $f.Controls.Add($station)
    Label-On $f 'กระดาษเคาน์เตอร์ / ห้องครัว (มม.)' 223
    $counterPaper=New-Object Windows.Forms.ComboBox;$counterPaper.DropDownStyle='DropDownList'
    $counterPaper.Location=New-Object Drawing.Point(20,252)
    [void]$counterPaper.Items.Add('80');[void]$counterPaper.Items.Add('58')
    $counterPaper.SelectedItem=if($old.counter_paper){[string]$old.counter_paper}else{'80'};$f.Controls.Add($counterPaper)
    $kitchenPaper=New-Object Windows.Forms.ComboBox;$kitchenPaper.DropDownStyle='DropDownList'
    $kitchenPaper.Location=New-Object Drawing.Point(180,252)
    [void]$kitchenPaper.Items.Add('80');[void]$kitchenPaper.Items.Add('58')
    $kitchenPaper.SelectedItem=if($old.kitchen_paper){[string]$old.kitchen_paper}else{'80'};$f.Controls.Add($kitchenPaper)
    $help=New-Object Windows.Forms.Label;$help.Location=New-Object Drawing.Point(20,300);$help.Size=New-Object Drawing.Size(550,90)
    $help.Text="ก่อนเริ่ม ให้ปิดตัวเลือก 'เปิดหน้าพิมพ์ใบเสร็จหลังยืนยันเงินสด' ในหน้า Settings แล้วบันทึก เพื่อไม่ให้พิมพ์ซ้ำจากเว็บ
เปิด Bridge เพียงคอม POS หลักเครื่องเดียว"
    $f.Controls.Add($help)
    $ok=New-Object Windows.Forms.Button
    $ok.Text='บันทึกและเริ่ม';$ok.Location=New-Object Drawing.Point(20,400);$ok.Size=New-Object Drawing.Size(160,38);$f.Controls.Add($ok)
    $testButton=New-Object Windows.Forms.Button
    $testButton.Text='ทดสอบ 3 ใบ';$testButton.Location=New-Object Drawing.Point(210,400);$testButton.Size=New-Object Drawing.Size(160,38);$f.Controls.Add($testButton)
    $testButton.Add_Click({
        $testButton.Enabled=$false
        try{
            if([string]$counter.SelectedItem -eq [string]$kitchen.SelectedItem){throw 'เลือกเครื่องเคาน์เตอร์และเครื่องครัวคนละชื่อ'}
            $row=$stationRows[$station.SelectedIndex]
            $sample=[pscustomobject]@{order=[pscustomobject]@{id='TEST';order_no='TEST-001';display_order_no='TEST-001';created_at=[DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss');customer_name='ทดสอบ';total=100;payment_method='TEST';is_test=$true};points=[pscustomobject]@{earned=2;balance=12;pending=0;member_linked=$true};items=@([pscustomobject]@{name='อาหารทดสอบ';quantity=1;line_total=60;department=[string]$row.name;station_id=[string]$row.id},[pscustomobject]@{name='น้ำทดสอบ';quantity=1;line_total=40;department='เครื่องดื่ม';station_id='other'})}
            Send-Print ([string]$counter.SelectedItem) ([int]$counterPaper.SelectedItem) (Get-Lines $sample 'receipt' @($sample.items))
            Send-Print ([string]$counter.SelectedItem) ([int]$counterPaper.SelectedItem) (Get-Lines $sample 'packing' @($sample.items))
            Send-Print ([string]$kitchen.SelectedItem) ([int]$kitchenPaper.SelectedItem) (Get-Lines $sample 'kitchen' @($sample.items[0]))
            [Windows.Forms.MessageBox]::Show('ส่งงานทดสอบเข้า Windows แล้ว กรุณาตรวจว่ากระดาษออกครบ 3 ใบและออกถูกเครื่อง')|Out-Null
        }catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message)|Out-Null}
        finally{$testButton.Enabled=$true}
    })
    $script:Chosen=$null
    $ok.Add_Click({
        if([string]$counter.SelectedItem -eq [string]$kitchen.SelectedItem){[Windows.Forms.MessageBox]::Show('เลือกเครื่องเคาน์เตอร์กับเครื่องครัวคนละชื่อ')|Out-Null;return}
        $row=$stationRows[$station.SelectedIndex]
        $script:Chosen=@{counter=[string]$counter.SelectedItem;kitchen=[string]$kitchen.SelectedItem;station_id=[string]$row.id;station_name=[string]$row.name;counter_paper=[int]$counterPaper.SelectedItem;kitchen_paper=[int]$kitchenPaper.SelectedItem}
        $f.DialogResult='OK';$f.Close()
    })
    $result=$f.ShowDialog();$f.Dispose();if($result -ne [Windows.Forms.DialogResult]::OK){return $null}
    Save-Json $script:ConfigPath $script:Chosen;return $script:Chosen
}
function Add-Line($List,[string]$Text,[bool]$Bold=$false){[void]$List.Add(@{text=$Text;bold=$Bold})}
function Get-Lines($Data,[string]$Kind,$Items){
    $lines=New-Object System.Collections.ArrayList;$o=$Data.order
    Add-Line $lines 'BAKE & BITE' $true
    $title=switch($Kind){'receipt'{'ใบเสร็จรับเงิน'}'packing'{'ใบจัดอาหารรวมทุกแผนก'}default{'ใบงานห้องครัว'}}
    Add-Line $lines $title $true
    if($o.is_test){Add-Line $lines 'ทดสอบ — ไม่ใช่ยอดขาย' $true}
    $number=if($o.display_order_no){$o.display_order_no}else{$o.order_no}
    Add-Line $lines ([string]$number) $true
    Add-Line $lines ([string]$o.created_at);Add-Line $lines ('ลูกค้า: '+[string]$o.customer_name)
    Add-Line $lines '-----------------------------'
    $qty=0
    foreach($item in $Items){
        $qty += [int]$item.quantity
        if($Kind -eq 'receipt'){Add-Line $lines (([string]$item.name)+' x '+$item.quantity+' = '+([decimal]$item.line_total).ToString('0.00')+' บาท')}
        else{Add-Line $lines ('[  ] '+([string]$item.name)+' x '+$item.quantity) $true;Add-Line $lines ('แผนก: '+[string]$item.department)}
    }
    Add-Line $lines '-----------------------------'
    if($Kind -eq 'receipt'){
        Add-Line $lines ('รวม '+([decimal]$o.total).ToString('0.00')+' บาท') $true
        Add-Line $lines ('ชำระ: '+[string]$o.payment_method)
        Add-Line $lines ('คะแนนที่รับครั้งนี้: '+[string]$Data.points.earned+' แต้ม')
        $balance=if($null -eq $Data.points.balance){'-'}else{[string]$Data.points.balance+' แต้ม'}
        Add-Line $lines ('ยอดคะแนนสะสม: '+$balance)
        if($Data.points.pending -gt 0){Add-Line $lines ('คะแนนรอรับผ่าน LINE: '+$Data.points.pending+' แต้ม')}
        if(-not $Data.points.member_linked){Add-Line $lines 'ออเดอร์นี้ยังไม่ผูกสมาชิก'}
        Add-Line $lines 'คะแนนสะสม ณ เวลาพิมพ์'
    }else{
        Add-Line $lines ('รวม '+$qty+' ชิ้น / '+@($Items).Count+' รายการ') $true
        Add-Line $lines '[  ] ตรวจจำนวนครบแล้ว';Add-Line $lines 'ผู้จัด ________ ผู้ตรวจ ________'
        Add-Line $lines 'ไม่ใช่ใบเสร็จรับเงิน'
    }
    if($o.note){Add-Line $lines ('หมายเหตุ: '+[string]$o.note)}
    return ,$lines
}
function Send-Print([string]$Printer,[int]$Paper,$Lines){
    $doc=New-Object Drawing.Printing.PrintDocument;$doc.PrinterSettings.PrinterName=$Printer
    if(-not $doc.PrinterSettings.IsValid){$doc.Dispose();throw ('เครื่องพิมพ์ไม่พร้อม: '+$Printer)}
    $doc.DocumentName='BakeBite - '+[string]$Lines[1].text
    $doc.PrintController=New-Object Drawing.Printing.StandardPrintController
    $width=[int][Math]::Round($Paper/25.4*100)
    $font=New-Object Drawing.Font('Tahoma',9);$bold=New-Object Drawing.Font('Tahoma',10,[Drawing.FontStyle]::Bold)
    $format=New-Object Drawing.StringFormat;$format.Trimming=[Drawing.StringTrimming]::None
    $doc.DefaultPageSettings.Margins=New-Object Drawing.Printing.Margins(6,6,6,6)
    $measure=$doc.PrinterSettings.CreateMeasurementGraphics()
    $measure.PageUnit=[Drawing.GraphicsUnit]::Display
    try{
        $height=18
        foreach($line in $Lines){
            $useFont=if($line.bold){$bold}else{$font}
            $size=$measure.MeasureString([string]$line.text,$useFont,($width-18),$format)
            $height += [int][Math]::Ceiling($size.Height)+4
        }
    }finally{$measure.Dispose()}
    $height=[Math]::Max(180,[Math]::Min(1100,$height))
    $doc.DefaultPageSettings.PaperSize=New-Object Drawing.Printing.PaperSize('BakeBite Roll',$width,$height)
    $position=@{index=0}
    $printBlock={
        param($sender,$e)
        $e.Graphics.PageUnit=[Drawing.GraphicsUnit]::Display
        $y=[single]$e.MarginBounds.Top;$printWidth=[single][Math]::Min($e.MarginBounds.Width,($width-18))
        while($position.index -lt $Lines.Count){
            $line=$Lines[$position.index];$useFont=if($line.bold){$bold}else{$font}
            $size=$e.Graphics.MeasureString([string]$line.text,$useFont,$printWidth,$format)
            $lineHeight=[single][Math]::Ceiling($size.Height)+4
            if($y+$lineHeight -gt $e.MarginBounds.Bottom -and $y -gt $e.MarginBounds.Top){$e.HasMorePages=$true;return}
            $rect=New-Object Drawing.RectangleF([single]$e.MarginBounds.Left,$y,$printWidth,$lineHeight)
            $e.Graphics.DrawString([string]$line.text,$useFont,[Drawing.Brushes]::Black,$rect,$format)
            $y += $lineHeight;$position.index++
        }
        $e.HasMorePages=$false
    }.GetNewClosure()
    $handler=[Drawing.Printing.PrintPageEventHandler]$printBlock
    $doc.add_PrintPage($handler)
    try{$doc.Print()}finally{$doc.Dispose();$font.Dispose();$bold.Dispose();$format.Dispose()}
}
function Save-State{Save-Json $script:StatePath $script:State}
function Send-Tracked($Data,[string]$Kind,[string]$Printer,[int]$Paper,$Items){
    $key=([string]$Data.order.id)+'/'+$Kind;$state=[string]$script:State.jobs[$key]
    if($state -eq 'submitted' -or $state -eq 'skipped'){return}
    if($state -eq 'sending' -or $state -eq 'attention'){
        $answer=[Windows.Forms.MessageBox]::Show(
            ("งาน "+$Data.order.order_no+" / "+$Kind+" เคยส่งแล้วแต่ยังยืนยันไม่ได้
ตรวจคิว Windows และกระดาษก่อน
Yes = พิมพ์ออกแล้ว ข้ามงานนี้
No = ส่งพิมพ์ซ้ำ (อาจได้ใบซ้ำ)
Cancel = หยุด Bridge"),
            'ตรวจงานพิมพ์ค้าง',[Windows.Forms.MessageBoxButtons]::YesNoCancel)
        if($answer -eq [Windows.Forms.DialogResult]::Yes){$script:State.jobs[$key]='submitted';Save-State;return}
        if($answer -ne [Windows.Forms.DialogResult]::No){throw 'หยุดเพื่อให้ตรวจงานพิมพ์ค้าง'}
    }
    if(@($Items).Count -eq 0){$script:State.jobs[$key]='skipped';Save-State;return}
    $script:State.jobs[$key]='sending';Save-State
    try{
        $lines=Get-Lines $Data $Kind $Items;Send-Print $Printer $Paper $lines
        $script:State.jobs[$key]='submitted';Save-State
        Write-Host ($Data.order.order_no+' / '+$Kind+' -> '+$Printer)
    }catch{$script:State.jobs[$key]='attention';Save-State;throw}
}
try{
    if(-not (Get-Login)){exit}
    $config=Get-Config;if($null -eq $config){exit}
    if(Test-Path $script:StatePath){$script:State=Convert-ToMap (Get-Content $script:StatePath -Raw|ConvertFrom-Json)}
    else{
        $script:State=@{version=1;since=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');after='00000000-0000-0000-0000-000000000000';jobs=@{}}
        Save-State
    }
    Write-Host 'Bake & Bite Print Bridge 0.1'
    Write-Host ('เคาน์เตอร์: '+$config.counter+' / ครัว: '+$config.kitchen+' / สถานี: '+$config.station_name)
    Write-Host 'เริ่มครั้งแรกจะรับเฉพาะบิลที่ชำระหลังเปิด Bridge ไม่ดึงบิลเก่ามาพิมพ์'
    Write-Host 'รับงาน POS ที่ชำระแล้วทุก 3 วินาที / Ctrl+C เพื่อหยุด'
    while($true){
        try{
            $since=[Uri]::EscapeDataString([string]$script:State.since)
            $after=[Uri]::EscapeDataString([string]$script:State.after)
            $feed=Api-Get ('action=bridge-orders&since='+$since+'&after='+$after)
            foreach($entry in $feed.orders){
                $data=Api-Get ('action=print-order&id='+[Uri]::EscapeDataString([string]$entry.id))
                if($data.order.payment_status -ne 'paid' -or $data.order.status -eq 'cancelled'){
                    $script:State.since=[string]$entry.paid_at;$script:State.after=[string]$entry.id;Save-State;continue
                }
                Send-Tracked $data 'receipt' $config.counter $config.counter_paper @($data.items)
                Send-Tracked $data 'packing' $config.counter $config.counter_paper @($data.items)
                $kitchenItems=@($data.items|Where-Object{[string]$_.station_id -eq $config.station_id})
                Send-Tracked $data 'kitchen' $config.kitchen $config.kitchen_paper $kitchenItems
                $script:State.since=[string]$entry.paid_at;$script:State.after=[string]$entry.id;Save-State
            }
        }catch{
            Write-Host 'หยุดรับงาน: ตรวจอินเทอร์เน็ต การเข้าสู่ระบบ และคิวเครื่องพิมพ์' -ForegroundColor Yellow
            Write-Host $_.Exception.Message -ForegroundColor Yellow
            [Windows.Forms.MessageBox]::Show('Bridge หยุดรับงานแล้ว ตรวจเครื่องพิมพ์และอินเทอร์เน็ต จากนั้นปิดและเปิดโปรแกรมใหม่ งานที่ส่งไปแล้วจะถูกจดจำไว้','Bake & Bite')|Out-Null
            break
        }
        Start-Sleep -Seconds 3
    }
}catch{[Windows.Forms.MessageBox]::Show($_.Exception.Message,'Bake & Bite Print Bridge')|Out-Null}
finally{$script:Token=$null;$mutex.ReleaseMutex();$mutex.Dispose()}
